import type { Logger } from "pino";

import type { ContractCallAlert, SwapAlert, TransferAlert, WalletAlert } from "../types/blockchain";
import { formatCoinList, formatDirection, formatTokenDescriptor, formatWallet } from "../utils/format";
import type { TelegramBotService } from "../bot/telegramBot";

export class NotificationService {
  private readonly logger: Logger;

  private readonly telegramBotService: TelegramBotService;

  public constructor(options: {
    readonly logger: Logger;
    readonly telegramBotService: TelegramBotService;
  }) {
    this.logger = options.logger.child({ component: "notification-service" });
    this.telegramBotService = options.telegramBotService;
  }

  public async sendAlert(alert: WalletAlert): Promise<void> {
    const message = this.formatAlert(alert);
    const delivered = await this.telegramBotService.broadcastAlert(message, alert);
    this.logger.info(
      { delivered, kind: alert.kind, txHash: alert.txHash, height: alert.height },
      "Alert dispatch completed",
    );
  }

  private formatAlert(alert: WalletAlert): string {
    switch (alert.kind) {
      case "transfer":
        return this.formatTransferAlert(alert);
      case "swap":
        return this.formatSwapAlert(alert);
      case "contract_call":
        return this.formatContractCallAlert(alert);
      default:
        return "Unsupported alert";
    }
  }

  private formatTransferAlert(alert: TransferAlert): string {
    const lines = [
      "🚨 Wallet Activity Detected",
      "",
      "Type: Transfer",
      `Direction: ${formatDirection(alert.direction)}`,
      `Wallet: ${formatWallet(alert.wallet)}`,
      "",
      `From: ${alert.fromAddress}`,
      `To: ${alert.toAddress}`,
      `Amount: ${formatCoinList(alert.amounts)}`,
      "",
      `Tx Hash: ${alert.txHash}`,
      `Block: ${alert.height}`,
    ];

    if (alert.timestamp) {
      lines.push(`Time: ${alert.timestamp}`);
    }

    if (alert.memo) {
      lines.push(`Memo: ${alert.memo}`);
    }

    return lines.join("\n");
  }

  private formatSwapAlert(alert: SwapAlert): string {
    const lines = [
      "🔁 Swap Detected",
      "",
      `Wallet: ${formatWallet(alert.wallet)}`,
      `Sender: ${alert.sender}`,
      `Contract: ${alert.targetContract ?? alert.contract}`,
    ];

    if (alert.inputToken) {
      lines.push(`Sent: ${formatTokenDescriptor(alert.inputToken)}`);
    }

    if (alert.outputToken) {
      lines.push(`Received: ${formatTokenDescriptor(alert.outputToken)}${alert.outputToken.amount ? "" : " (inferred)"}`);
    }

    if (alert.memo) {
      lines.push(`Memo: ${alert.memo}`);
    }

    lines.push("", `Tx Hash: ${alert.txHash}`, `Block: ${alert.height}`);

    if (alert.timestamp) {
      lines.push(`Time: ${alert.timestamp}`);
    }

    return lines.join("\n");
  }

  private formatContractCallAlert(alert: ContractCallAlert): string {
    const lines = [
      "⚙️ Contract Activity Detected",
      "",
      `Wallet: ${formatWallet(alert.wallet)}`,
      `Summary: ${alert.summary}`,
      `Sender: ${alert.sender}`,
      `Contract: ${alert.targetContract ?? alert.contract}`,
    ];

    if (alert.recipient) {
      lines.push(`Recipient: ${alert.recipient}`);
    }

    if (alert.assetLabel && alert.amount) {
      lines.push(`Asset: ${alert.amount} ${alert.assetLabel}`);
    }

    if (alert.direction) {
      lines.push(`Direction: ${formatDirection(alert.direction)}`);
    }

    if (alert.memo) {
      lines.push(`Memo: ${alert.memo}`);
    }

    lines.push("", `Tx Hash: ${alert.txHash}`, `Block: ${alert.height}`);

    if (alert.timestamp) {
      lines.push(`Time: ${alert.timestamp}`);
    }

    return lines.join("\n");
  }
}
