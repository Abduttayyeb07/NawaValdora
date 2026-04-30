import type { Logger } from "pino";

import type {
  AlertDirection,
  ContractCallAlert,
  NormalizedCoin,
  ParsedContractCallMessage,
  ParsedContractTransferMessage,
  ParsedSwapMessage,
  ParsedTransaction,
  TrackedWallet,
  TransferAlert,
  WalletAlert,
} from "../types/blockchain";
import { parseCoinsString } from "../utils/format";
import type { NotificationService } from "./notificationService";

export class TransactionMonitorService {
  private readonly logger: Logger;

  private readonly notificationService: NotificationService;

  private readonly trackedWalletsByAddress: ReadonlyMap<string, TrackedWallet>;

  public constructor(options: {
    readonly logger: Logger;
    readonly notificationService: NotificationService;
    readonly trackedWallets: readonly TrackedWallet[];
  }) {
    this.logger = options.logger.child({ component: "transaction-monitor" });
    this.notificationService = options.notificationService;
    this.trackedWalletsByAddress = new Map(
      options.trackedWallets.map((wallet) => [wallet.address, wallet] as const),
    );
  }

  public async handleTransaction(transaction: ParsedTransaction): Promise<void> {
    if (transaction.code !== 0) {
      this.logger.debug(
        { txHash: transaction.hash, height: transaction.height, code: transaction.code },
        "Skipping failed transaction",
      );
      return;
    }

    const alerts = this.createAlerts(transaction);
    if (alerts.length === 0) {
      this.logger.debug(
        { height: transaction.height, messageCount: transaction.messages.length, txHash: transaction.hash },
        "Transaction did not match any tracked wallet",
      );
      return;
    }

    this.logger.info(
      { alertCount: alerts.length, height: transaction.height, txHash: transaction.hash },
      "Matched tracked wallet activity",
    );
    for (const alert of alerts) {
      await this.notificationService.sendAlert(alert);
    }
  }

  private createAlerts(transaction: ParsedTransaction): WalletAlert[] {
    const alerts: WalletAlert[] = [];
    const alertedAddresses = new Set<string>();

    for (const message of transaction.messages) {
      switch (message.kind) {
        case "transfer": {
          const senderWallet = this.trackedWalletsByAddress.get(message.fromAddress);
          const recipientWallet = this.trackedWalletsByAddress.get(message.toAddress);

          if (senderWallet) {
            alertedAddresses.add(senderWallet.address);
            alerts.push(
              this.buildTransferAlert(transaction, senderWallet, "OUTFLOW", message.fromAddress, message.toAddress, message.amounts),
            );
          }

          if (recipientWallet) {
            alertedAddresses.add(recipientWallet.address);
            const direction: AlertDirection =
              senderWallet && senderWallet.address === recipientWallet.address ? "INTERNAL" : "INFLOW";
            alerts.push(
              this.buildTransferAlert(transaction, recipientWallet, direction, message.fromAddress, message.toAddress, message.amounts),
            );
          }

          break;
        }
        case "swap": {
          const wallet = this.trackedWalletsByAddress.get(message.sender);
          if (wallet) {
            alertedAddresses.add(wallet.address);
            alerts.push(this.buildSwapAlert(transaction, wallet, message));
          }
          break;
        }
        case "contract_transfer": {
          const contractTransferAlerts = this.buildContractTransferAlerts(transaction, message);
          for (const a of contractTransferAlerts) {
            alertedAddresses.add(a.wallet.address);
          }
          alerts.push(...contractTransferAlerts);
          break;
        }
        case "contract_call": {
          const wallet = this.trackedWalletsByAddress.get(message.sender);
          if (wallet) {
            alertedAddresses.add(wallet.address);
            alerts.push(this.buildContractCallAlert(transaction, wallet, message));
          }
          break;
        }
        default:
          break;
      }
    }

    // Catch inflows that only appear in raw events (e.g. a third-party contract
    // depositing funds to a tracked wallet — the tracked wallet is neither the
    // MsgExecuteContract sender nor the contract address).
    alerts.push(...this.buildEventInflowAlerts(transaction, alertedAddresses));

    return alerts;
  }

  private buildEventInflowAlerts(
    transaction: ParsedTransaction,
    alreadyAlerted: ReadonlySet<string>,
  ): TransferAlert[] {
    const alerts: TransferAlert[] = [];

    // Collect per-recipient amounts from transfer events (which carry sender info).
    // coin_received events duplicate the same transfers without sender, so prefer transfer.
    const inflowsByRecipient = new Map<string, { amounts: NormalizedCoin[]; fromAddress: string }>();

    for (const event of transaction.rawEvents) {
      if (event.type !== "transfer") {
        continue;
      }

      const attrs = Object.fromEntries(event.attributes.map((a) => [a.key, a.value]));
      const recipient = attrs.recipient ?? "";
      const sender = attrs.sender ?? "";
      const amountStr = attrs.amount ?? "";

      if (!recipient || alreadyAlerted.has(recipient)) {
        continue;
      }

      const wallet = this.trackedWalletsByAddress.get(recipient);
      if (!wallet) {
        continue;
      }

      const existing = inflowsByRecipient.get(recipient);
      const parsed = parseCoinsString(amountStr);
      if (existing) {
        existing.amounts.push(...parsed);
      } else {
        inflowsByRecipient.set(recipient, { amounts: parsed, fromAddress: sender });
      }
    }

    for (const [recipientAddress, { amounts, fromAddress }] of inflowsByRecipient) {
      const wallet = this.trackedWalletsByAddress.get(recipientAddress);
      if (!wallet) {
        continue;
      }

      this.logger.info(
        { fromAddress, recipient: recipientAddress, txHash: transaction.hash },
        "Event-based inflow detected for tracked wallet",
      );

      alerts.push(
        this.buildTransferAlert(transaction, wallet, "INFLOW", fromAddress, recipientAddress, amounts),
      );
    }

    return alerts;
  }

  private buildTransferAlert(
    transaction: ParsedTransaction,
    wallet: TrackedWallet,
    direction: AlertDirection,
    fromAddress: string,
    toAddress: string,
    amounts: TransferAlert["amounts"],
  ): TransferAlert {
    return {
      amounts,
      direction,
      fromAddress,
      height: transaction.height,
      kind: "transfer",
      ...(transaction.memo ? { memo: transaction.memo } : {}),
      ...(transaction.timestamp ? { timestamp: transaction.timestamp } : {}),
      toAddress,
      txHash: transaction.hash,
      wallet,
    };
  }

  private buildSwapAlert(
    transaction: ParsedTransaction,
    wallet: TrackedWallet,
    message: ParsedSwapMessage,
  ): WalletAlert {
    return {
      contract: message.contract,
      height: transaction.height,
      ...(message.inputToken ? { inputToken: message.inputToken } : {}),
      kind: "swap",
      ...(transaction.memo ?? message.memo ? { memo: transaction.memo ?? message.memo } : {}),
      ...(message.outputToken ? { outputToken: message.outputToken } : {}),
      sender: message.sender,
      ...(message.targetContract ? { targetContract: message.targetContract } : {}),
      ...(transaction.timestamp ? { timestamp: transaction.timestamp } : {}),
      txHash: transaction.hash,
      wallet,
    };
  }

  private buildContractTransferAlerts(
    transaction: ParsedTransaction,
    message: ParsedContractTransferMessage,
  ): ContractCallAlert[] {
    const alerts: ContractCallAlert[] = [];
    const senderWallet = this.trackedWalletsByAddress.get(message.sender);
    const recipientWallet = message.recipient
      ? this.trackedWalletsByAddress.get(message.recipient)
      : undefined;

    if (senderWallet) {
      alerts.push({
        ...(message.amount ? { amount: message.amount } : {}),
        ...(message.assetLabel ? { assetLabel: message.assetLabel } : {}),
        contract: message.contract,
        direction: "OUTFLOW",
        height: transaction.height,
        kind: "contract_call",
        ...(transaction.memo ? { memo: transaction.memo } : {}),
        ...(message.recipient ? { recipient: message.recipient } : {}),
        sender: message.sender,
        summary: "Contract token transfer",
        ...(message.targetContract ? { targetContract: message.targetContract } : {}),
        ...(transaction.timestamp ? { timestamp: transaction.timestamp } : {}),
        txHash: transaction.hash,
        wallet: senderWallet,
      });
    }

    if (recipientWallet) {
      alerts.push({
        ...(message.amount ? { amount: message.amount } : {}),
        ...(message.assetLabel ? { assetLabel: message.assetLabel } : {}),
        contract: message.contract,
        direction: senderWallet && senderWallet.address === recipientWallet.address ? "INTERNAL" : "INFLOW",
        height: transaction.height,
        kind: "contract_call",
        ...(transaction.memo ? { memo: transaction.memo } : {}),
        ...(message.recipient ? { recipient: message.recipient } : {}),
        sender: message.sender,
        summary: "Contract token transfer",
        ...(message.targetContract ? { targetContract: message.targetContract } : {}),
        ...(transaction.timestamp ? { timestamp: transaction.timestamp } : {}),
        txHash: transaction.hash,
        wallet: recipientWallet,
      });
    }

    return alerts;
  }

  private buildContractCallAlert(
    transaction: ParsedTransaction,
    wallet: TrackedWallet,
    message: ParsedContractCallMessage,
  ): ContractCallAlert {
    return {
      contract: message.contract,
      height: transaction.height,
      kind: "contract_call",
      ...(transaction.memo ? { memo: transaction.memo } : {}),
      sender: message.sender,
      summary: message.summary,
      ...(transaction.timestamp ? { timestamp: transaction.timestamp } : {}),
      txHash: transaction.hash,
      wallet,
    };
  }
}
