import type { Logger } from "pino";

import type {
  AlertDirection,
  ContractCallAlert,
  ParsedContractCallMessage,
  ParsedContractTransferMessage,
  ParsedSwapMessage,
  ParsedTransaction,
  TrackedWallet,
  TransferAlert,
  WalletAlert,
} from "../types/blockchain";
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
    for (const alert of alerts) {
      await this.notificationService.sendAlert(alert);
    }
  }

  private createAlerts(transaction: ParsedTransaction): WalletAlert[] {
    const alerts: WalletAlert[] = [];

    for (const message of transaction.messages) {
      switch (message.kind) {
        case "transfer": {
          const senderWallet = this.trackedWalletsByAddress.get(message.fromAddress);
          const recipientWallet = this.trackedWalletsByAddress.get(message.toAddress);

          if (senderWallet) {
            alerts.push(
              this.buildTransferAlert(transaction, senderWallet, "OUTFLOW", message.fromAddress, message.toAddress, message.amounts),
            );
          }

          if (recipientWallet) {
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
            alerts.push(this.buildSwapAlert(transaction, wallet, message));
          }
          break;
        }
        case "contract_transfer": {
          alerts.push(...this.buildContractTransferAlerts(transaction, message));
          break;
        }
        case "contract_call": {
          const wallet = this.trackedWalletsByAddress.get(message.sender);
          if (wallet) {
            alerts.push(this.buildContractCallAlert(transaction, wallet, message));
          }
          break;
        }
        default:
          break;
      }
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
