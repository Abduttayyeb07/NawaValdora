import { createHash } from "node:crypto";

import { fromBase64 } from "@cosmjs/encoding";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { Tx } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { MsgTransfer } from "cosmjs-types/ibc/applications/transfer/v1/tx";

import type {
  IndexedEvent,
  NormalizedCoin,
  ParsedContractCallMessage,
  ParsedContractTransferMessage,
  ParsedMessage,
  ParsedSwapMessage,
  ParsedTransaction,
  RpcTxResult,
  TokenDescriptor,
} from "../types/blockchain";
import { formatCoinList, normalizeEvents, parseCoinsString } from "../utils/format";

type JsonObject = Record<string, unknown>;

const textDecoder = new TextDecoder();

function asRecord(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRecordArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map((item) => asRecord(item)).filter((item): item is JsonObject => item !== null)
    : [];
}

function normalizeCoins(
  coins: readonly { amount: string; denom: string }[] | undefined,
): NormalizedCoin[] {
  return coins?.map((coin) => ({ amount: coin.amount, denom: coin.denom })) ?? [];
}

function parseJsonPayload(payload: string): JsonObject | null {
  try {
    return asRecord(JSON.parse(payload));
  } catch {
    return null;
  }
}

function pickActionName(payload: JsonObject | null): string {
  if (!payload) {
    return "execute_contract";
  }

  const [firstKey] = Object.keys(payload);
  return firstKey ?? "execute_contract";
}

function decodeNestedSendMessage(payload: JsonObject | null): JsonObject | null {
  const sendPayload = payload ? asRecord(payload.send) : null;
  const encoded = sendPayload ? asString(sendPayload.msg) : undefined;
  if (!encoded) {
    return null;
  }

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    return parseJsonPayload(decoded);
  } catch {
    return null;
  }
}

function extractAssetDescriptor(assetInfo: JsonObject | null, amount?: string): TokenDescriptor | undefined {
  if (!assetInfo) {
    return undefined;
  }

  const nativeToken = asRecord(assetInfo.native_token);
  const nativeDenom = nativeToken ? asString(nativeToken.denom) : undefined;
  if (nativeDenom) {
    return {
      ...(amount ? { amount } : {}),
      denom: nativeDenom,
      displayName: nativeDenom,
    };
  }

  const token = asRecord(assetInfo.token);
  const contractAddress = token ? asString(token.contract_addr) : undefined;
  if (contractAddress) {
    return {
      ...(amount ? { amount } : {}),
      displayName: contractAddress,
    };
  }

  return undefined;
}

function isSwapPayload(payload: JsonObject | null): boolean {
  if (!payload) {
    return false;
  }

  const swapKeys = [
    "swap",
    "execute_swap_operations",
    "swap_exact_amount_in",
    "swap_exact_amount_out",
    "multi_swap",
  ];

  return swapKeys.some((key) => key in payload);
}

function isContractTransferPayload(payload: JsonObject | null): boolean {
  if (!payload) {
    return false;
  }

  return "transfer" in payload || "send" in payload;
}

function inferOutputFromEvents(events: readonly IndexedEvent[], address: string): TokenDescriptor | undefined {
  const receivedCoins: NormalizedCoin[] = [];

  for (const event of events) {
    const attributes = Object.fromEntries(
      event.attributes.map((attribute) => [attribute.key, attribute.value]),
    );

    if (event.type === "coin_received" && attributes.receiver === address && attributes.amount) {
      receivedCoins.push(...parseCoinsString(attributes.amount));
      continue;
    }

    if (event.type === "transfer" && attributes.recipient === address && attributes.amount) {
      receivedCoins.push(...parseCoinsString(attributes.amount));
    }
  }

  if (receivedCoins.length === 0) {
    return undefined;
  }

  if (receivedCoins.length === 1) {
    const [coin] = receivedCoins;
    if (!coin) {
      return undefined;
    }

    return {
      amount: coin.amount,
      denom: coin.denom,
      displayName: coin.denom,
    };
  }

  return {
    displayName: formatCoinList(receivedCoins),
  };
}

function extractSwapDetails(options: {
  readonly contract: string;
  readonly funds: readonly NormalizedCoin[];
  readonly nestedPayload: JsonObject | null;
  readonly payload: JsonObject | null;
}): {
  readonly inputToken?: TokenDescriptor;
  readonly outputToken?: TokenDescriptor;
  readonly swapAction: string;
  readonly targetContract?: string;
} {
  const { contract, funds, nestedPayload, payload } = options;
  const activePayload = isSwapPayload(payload) ? payload : nestedPayload;
  const sendPayload = payload ? asRecord(payload.send) : null;
  const swapRecord = activePayload
    ? asRecord(
        activePayload.swap ??
          activePayload.execute_swap_operations ??
          activePayload.swap_exact_amount_in ??
          activePayload.swap_exact_amount_out ??
          activePayload.multi_swap,
      )
    : null;

  let inputToken: TokenDescriptor | undefined;

  const offerAsset = swapRecord ? asRecord(swapRecord.offer_asset) : null;
  const offerAmount = offerAsset ? asString(offerAsset.amount) : undefined;
  const offerInfo = offerAsset ? asRecord(offerAsset.info) : null;

  if (offerInfo) {
    inputToken = extractAssetDescriptor(offerInfo, offerAmount);
  } else if (sendPayload) {
    const sendAmount = asString(sendPayload.amount);
    inputToken = {
      ...(sendAmount ? { amount: sendAmount } : {}),
      displayName: contract,
    };
  } else if (funds.length > 0) {
    const [firstFund] = funds;
    if (firstFund) {
      inputToken = {
        amount: firstFund.amount,
        denom: firstFund.denom,
        displayName: firstFund.denom,
      };
    }
  }

  let outputToken: TokenDescriptor | undefined;
  const askAssetInfo = swapRecord ? asRecord(swapRecord.ask_asset_info ?? swapRecord.to_asset_info) : null;
  if (askAssetInfo) {
    outputToken = extractAssetDescriptor(askAssetInfo);
  }

  const operations = swapRecord ? asRecordArray(swapRecord.operations) : [];
  if (!outputToken && operations.length > 0) {
    const [lastOperation] = operations.slice(-1);
    const askAssetInfoFromOperation = lastOperation
      ? asRecord(lastOperation.ask_asset_info ?? lastOperation.to_asset_info)
      : null;

    if (askAssetInfoFromOperation) {
      outputToken = extractAssetDescriptor(askAssetInfoFromOperation);
    } else if (lastOperation) {
      const denomOut = asString(lastOperation.denom_out);
      if (denomOut) {
        outputToken = {
          denom: denomOut,
          displayName: denomOut,
        };
      }
    }
  }

  const operationList = swapRecord ? asStringArray(swapRecord.operations) : [];
  if (!outputToken && operationList.length > 0) {
    const [lastOperation] = operationList.slice(-1);
    if (lastOperation) {
      outputToken = { displayName: lastOperation };
    }
  }

  const targetContract = sendPayload ? asString(sendPayload.contract) : undefined;

  return {
    ...(inputToken ? { inputToken } : {}),
    ...(outputToken ? { outputToken } : {}),
    swapAction: pickActionName(activePayload),
    ...(targetContract ? { targetContract } : {}),
  };
}

function extractContractTransferDetails(options: {
  readonly contract: string;
  readonly payload: JsonObject | null;
}): {
  readonly amount?: string;
  readonly assetLabel: string;
  readonly contract: string;
  readonly recipient?: string;
  readonly targetContract?: string;
} {
  const { contract, payload } = options;
  const transferPayload = payload ? asRecord(payload.transfer) : null;
  if (transferPayload) {
    const amount = asString(transferPayload.amount);
    const recipient = asString(transferPayload.recipient);

    return {
      ...(amount ? { amount } : {}),
      assetLabel: contract,
      contract,
      ...(recipient ? { recipient } : {}),
    };
  }

  const sendPayload = payload ? asRecord(payload.send) : null;
  const amount = sendPayload ? asString(sendPayload.amount) : undefined;
  const recipient = sendPayload ? asString(sendPayload.contract) : undefined;

  return {
    ...(amount ? { amount } : {}),
    assetLabel: contract,
    contract,
    ...(recipient ? { recipient } : {}),
    ...(recipient ? { targetContract: recipient } : {}),
  };
}

function extractExecuteContractMessage(options: {
  readonly contract: string;
  readonly events: readonly IndexedEvent[];
  readonly funds: readonly NormalizedCoin[];
  readonly payload: string;
  readonly sender: string;
}): ParsedMessage {
  const decodedMsg = parseJsonPayload(options.payload);
  const nestedPayload = decodeNestedSendMessage(decodedMsg);

  if (isSwapPayload(decodedMsg) || isSwapPayload(nestedPayload)) {
    const swapDetails = extractSwapDetails({
      contract: options.contract,
      funds: options.funds,
      nestedPayload,
      payload: decodedMsg,
    });

    const inferredOutput = inferOutputFromEvents(options.events, options.sender);
    return {
      contract: options.contract,
      decodedMsg,
      funds: [...options.funds],
      ...(swapDetails.inputToken ? { inputToken: swapDetails.inputToken } : {}),
      kind: "swap",
      ...(inferredOutput || swapDetails.outputToken
        ? { outputToken: inferredOutput ?? swapDetails.outputToken }
        : {}),
      rawPayload: options.payload,
      sender: options.sender,
      swapAction: swapDetails.swapAction,
      ...(swapDetails.targetContract ? { targetContract: swapDetails.targetContract } : {}),
      typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
    };
  }

  if (isContractTransferPayload(decodedMsg)) {
    const details = extractContractTransferDetails({
      contract: options.contract,
      payload: decodedMsg,
    });

    return {
      ...details,
      decodedMsg,
      kind: "contract_transfer",
      sender: options.sender,
      typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
    };
  }

  const summary = pickActionName(decodedMsg);
  const contractCall: ParsedContractCallMessage = {
    contract: options.contract,
    decodedMsg,
    funds: [...options.funds],
    kind: "contract_call",
    rawPayload: options.payload,
    sender: options.sender,
    summary,
    typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
  };

  return contractCall;
}

export class TransactionParser {
  public parseTransaction(options: {
    readonly height: number;
    readonly timestamp?: string;
    readonly txBase64: string;
    readonly txResult?: RpcTxResult;
  }): ParsedTransaction {
    const txBytes = fromBase64(options.txBase64);
    const decodedTx = Tx.decode(txBytes);
    const rawEvents = normalizeEvents(options.txResult?.events ?? []);
    const messages = (decodedTx.body?.messages ?? [])
      .map((message) => this.parseMessage(message.typeUrl, message.value, rawEvents))
      .filter((message): message is ParsedMessage => message !== null);

    const memo = decodedTx.body?.memo?.trim() ? decodedTx.body.memo.trim() : undefined;
    const fee = normalizeCoins(decodedTx.authInfo?.fee?.amount);

    return {
      code: options.txResult?.code ?? 0,
      fee,
      hash: createHash("sha256").update(txBytes).digest("hex").toUpperCase(),
      height: options.height,
      ...(memo ? { memo } : {}),
      messages,
      rawEvents,
      ...(options.txResult?.log ? { rawLog: options.txResult.log } : {}),
      ...(options.timestamp ? { timestamp: options.timestamp } : {}),
    };
  }

  private parseMessage(
    typeUrl: string,
    value: Uint8Array,
    events: readonly IndexedEvent[],
  ): ParsedMessage | null {
    switch (typeUrl) {
      case "/cosmos.bank.v1beta1.MsgSend": {
        const message = MsgSend.decode(value);
        return {
          amounts: normalizeCoins(message.amount),
          fromAddress: message.fromAddress,
          kind: "transfer",
          toAddress: message.toAddress,
          typeUrl: "/cosmos.bank.v1beta1.MsgSend",
        };
      }
      case "/ibc.applications.transfer.v1.MsgTransfer": {
        const message = MsgTransfer.decode(value);
        const token = message.token;
        return {
          amounts: token ? [{ amount: token.amount, denom: token.denom }] : [],
          fromAddress: message.sender,
          kind: "transfer",
          toAddress: message.receiver,
          typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
        };
      }
      case "/cosmwasm.wasm.v1.MsgExecuteContract": {
        const message = MsgExecuteContract.decode(value);
        const payload = textDecoder.decode(message.msg);

        return extractExecuteContractMessage({
          contract: message.contract,
          events,
          funds: normalizeCoins(message.funds),
          payload,
          sender: message.sender,
        });
      }
      default:
        return null;
    }
  }
}
