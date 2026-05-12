export interface NormalizedCoin {
  readonly amount: string;
  readonly denom: string;
}

export interface TokenDescriptor {
  readonly amount?: string;
  readonly denom?: string;
  readonly displayName: string;
}

export interface EventAttribute {
  readonly key: string;
  readonly value: string;
}

export interface IndexedEvent {
  readonly attributes: EventAttribute[];
  readonly type: string;
}

export interface RpcTxResult {
  readonly code: number;
  readonly events: IndexedEvent[];
  readonly gasUsed?: string;
  readonly gasWanted?: string;
  readonly log?: string;
}

export interface TrackedWallet {
  readonly address: string;
  readonly kind: "vault" | "nawa_usdc" | "pmp" | "valdora_vault" | "smrwa";
  readonly label: string;
}

export type MessageKind = "transfer" | "swap" | "contract_transfer" | "contract_call";

export interface ParsedTransferMessage {
  readonly amounts: NormalizedCoin[];
  readonly fromAddress: string;
  readonly kind: "transfer";
  readonly toAddress: string;
  readonly typeUrl: "/cosmos.bank.v1beta1.MsgSend";
}

export interface ParsedSwapMessage {
  readonly contract: string;
  readonly decodedMsg: Record<string, unknown> | null;
  readonly funds: NormalizedCoin[];
  readonly inputToken?: TokenDescriptor;
  readonly kind: "swap";
  readonly memo?: string;
  readonly outputToken?: TokenDescriptor;
  readonly rawPayload: string;
  readonly sender: string;
  readonly swapAction: string;
  readonly targetContract?: string;
  readonly typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract";
}

export interface ParsedContractTransferMessage {
  readonly amount?: string;
  readonly assetLabel: string;
  readonly contract: string;
  readonly decodedMsg: Record<string, unknown> | null;
  readonly kind: "contract_transfer";
  readonly recipient?: string;
  readonly sender: string;
  readonly targetContract?: string;
  readonly typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract";
}

export interface ParsedContractCallMessage {
  readonly contract: string;
  readonly decodedMsg: Record<string, unknown> | null;
  readonly funds: NormalizedCoin[];
  readonly kind: "contract_call";
  readonly rawPayload: string;
  readonly sender: string;
  readonly summary: string;
  readonly typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract";
}

export type ParsedMessage =
  | ParsedTransferMessage
  | ParsedSwapMessage
  | ParsedContractTransferMessage
  | ParsedContractCallMessage;

export interface ParsedTransaction {
  readonly code: number;
  readonly fee: NormalizedCoin[];
  readonly hash: string;
  readonly height: number;
  readonly memo?: string;
  readonly messages: ParsedMessage[];
  readonly rawEvents: IndexedEvent[];
  readonly rawLog?: string;
  readonly timestamp?: string;
}

export type AlertDirection = "INFLOW" | "OUTFLOW" | "INTERNAL";

export interface TransferAlert {
  readonly amounts: NormalizedCoin[];
  readonly direction: AlertDirection;
  readonly fromAddress: string;
  readonly height: number;
  readonly kind: "transfer";
  readonly memo?: string;
  readonly timestamp?: string;
  readonly toAddress: string;
  readonly txHash: string;
  readonly wallet: TrackedWallet;
}

export interface SwapAlert {
  readonly contract: string;
  readonly height: number;
  readonly inputToken?: TokenDescriptor;
  readonly kind: "swap";
  readonly memo?: string;
  readonly outputToken?: TokenDescriptor;
  readonly sender: string;
  readonly targetContract?: string;
  readonly timestamp?: string;
  readonly txHash: string;
  readonly wallet: TrackedWallet;
}

export interface ContractCallAlert {
  readonly amount?: string;
  readonly assetLabel?: string;
  readonly contract: string;
  readonly direction?: AlertDirection;
  readonly height: number;
  readonly kind: "contract_call";
  readonly memo?: string;
  readonly recipient?: string;
  readonly sender: string;
  readonly summary: string;
  readonly targetContract?: string;
  readonly timestamp?: string;
  readonly txHash: string;
  readonly wallet: TrackedWallet;
}

export type WalletAlert = TransferAlert | SwapAlert | ContractCallAlert;
