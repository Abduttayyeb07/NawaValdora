import type { Logger } from "pino";

import type { ContractCallAlert, SwapAlert, TransferAlert, WalletAlert } from "../types/blockchain";
import { formatCoinList, formatTokenDescriptor } from "../utils/format";
import type { TelegramBotService } from "../bot/telegramBot";
import type { GoogleSheetsService } from "./googleSheetsService";

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function txLink(hash: string): string {
  return `<a href="https://www.zigscan.org/tx/${hash}">${hash}</a>`;
}

export class NotificationService {
  private readonly googleSheetsService: GoogleSheetsService | null;

  private readonly logger: Logger;

  private readonly telegramBotService: TelegramBotService;

  public constructor(options: {
    readonly googleSheetsService?: GoogleSheetsService;
    readonly logger: Logger;
    readonly telegramBotService: TelegramBotService;
  }) {
    this.logger = options.logger.child({ component: "notification-service" });
    this.telegramBotService = options.telegramBotService;
    this.googleSheetsService = options.googleSheetsService ?? null;
  }

  public async sendAlert(alert: WalletAlert): Promise<void> {
    const message = this.formatAlert(alert);
    const [delivered] = await Promise.all([
      this.telegramBotService.broadcastAlert(message, alert),
      this.googleSheetsService?.writeAlert(alert),
    ]);
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
    const directionLabel =
      alert.direction === "INFLOW" ? "Inflow" :
      alert.direction === "OUTFLOW" ? "Outflow" : "Internal Transfer";
    const emoji = alert.direction === "INFLOW" ? "💰" : alert.direction === "OUTFLOW" ? "🚨" : "🔄";

    const lines = [
      `${emoji} <b>${esc(alert.wallet.label)} — ${directionLabel} Detected</b>`,
      "",
      `From: <code>${alert.fromAddress}</code>`,
      `To: <code>${alert.toAddress}</code>`,
      `Amount: ${esc(formatCoinList(alert.amounts))}`,
    ];

    if (alert.memo) {
      lines.push(`Memo: ${esc(alert.memo)}`);
    }

    lines.push("", `Tx: ${txLink(alert.txHash)}`, `Block: ${alert.height}`);

    return lines.join("\n");
  }

  private formatSwapAlert(alert: SwapAlert): string {
    const lines = [
      `🔁 <b>${esc(alert.wallet.label)} — Swap Detected</b>`,
      "",
      `Sender: <code>${alert.sender}</code>`,
    ];

    if (alert.inputToken) {
      lines.push(`Sent: ${esc(formatTokenDescriptor(alert.inputToken))}`);
    }

    if (alert.outputToken) {
      lines.push(`Received: ${esc(formatTokenDescriptor(alert.outputToken))}${alert.outputToken.amount ? "" : " (inferred)"}`);
    }

    if (alert.memo) {
      lines.push(`Memo: ${esc(alert.memo)}`);
    }

    lines.push("", `Tx: ${txLink(alert.txHash)}`, `Block: ${alert.height}`);

    return lines.join("\n");
  }

  private formatContractCallAlert(alert: ContractCallAlert): string {
    const directionLabel =
      alert.direction === "INFLOW" ? "Inflow" :
      alert.direction === "OUTFLOW" ? "Outflow" :
      alert.direction === "INTERNAL" ? "Internal" : "";

    const lines = [
      `⚙️ <b>${esc(alert.wallet.label)} — Contract Activity${directionLabel ? ` (${directionLabel})` : ""}</b>`,
      "",
      `Summary: ${esc(alert.summary)}`,
      `Sender: <code>${alert.sender}</code>`,
      `Contract: <code>${alert.targetContract ?? alert.contract}</code>`,
    ];

    if (alert.recipient) {
      lines.push(`Recipient: <code>${alert.recipient}</code>`);
    }

    if (alert.assetLabel && alert.amount) {
      lines.push(`Asset: ${esc(alert.amount)} ${esc(alert.assetLabel)}`);
    }

    if (alert.memo) {
      lines.push(`Memo: ${esc(alert.memo)}`);
    }

    lines.push("", `Tx: ${txLink(alert.txHash)}`, `Block: ${alert.height}`);

    return lines.join("\n");
  }
}
