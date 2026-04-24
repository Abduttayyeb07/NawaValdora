import { google } from "googleapis";
import type { Logger } from "pino";

import type { ContractCallAlert, SwapAlert, TransferAlert, WalletAlert } from "../types/blockchain";
import { formatCoinList, formatTokenDescriptor } from "../utils/format";

const HEADER_ROW = [
  "Timestamp",
  "Type",
  "Wallet",
  "Direction",
  "From / Sender",
  "To / Contract",
  "Amount",
  "Tx Hash",
  "Block",
];

export class GoogleSheetsService {
  private readonly logger: Logger;

  private readonly sheets: ReturnType<typeof google.sheets>;

  private readonly spreadsheetId: string;

  private writeCount = 0;

  public constructor(options: {
    readonly credentialsPath: string;
    readonly logger: Logger;
    readonly spreadsheetId: string;
  }) {
    this.logger = options.logger.child({ component: "google-sheets" });
    this.spreadsheetId = options.spreadsheetId;

    const auth = new google.auth.GoogleAuth({
      keyFile: options.credentialsPath,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    this.sheets = google.sheets({ version: "v4", auth });
  }

  public getWriteCount(): number {
    return this.writeCount;
  }

  public async initialize(): Promise<void> {
    const response = await this.sheets.spreadsheets.values.get({
      range: "A1:I1",
      spreadsheetId: this.spreadsheetId,
    });

    if (response.data.values && response.data.values.length > 0) {
      this.logger.info("Google Sheets header already exists");
      return;
    }

    await this.sheets.spreadsheets.values.append({
      range: "A1",
      requestBody: { values: [HEADER_ROW] },
      spreadsheetId: this.spreadsheetId,
      valueInputOption: "RAW",
    });

    this.logger.info("Google Sheets header row written");
  }

  public async writeAlert(alert: WalletAlert): Promise<void> {
    try {
      const row = this.buildRow(alert);
      await this.sheets.spreadsheets.values.append({
        range: "A1",
        requestBody: { values: [row] },
        spreadsheetId: this.spreadsheetId,
        valueInputOption: "RAW",
      });
      this.writeCount += 1;
      this.logger.info(
        { height: alert.height, txHash: alert.txHash, writeCount: this.writeCount },
        "Alert written to Google Sheets",
      );
    } catch (error) {
      this.logger.error(
        { error, height: alert.height, txHash: alert.txHash },
        "Failed to write alert to Google Sheets",
      );
    }
  }

  private formatTimestamp(raw: string): string {
    const d = new Date(raw);
    const month = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    const day = d.getUTCDate();
    const year = d.getUTCFullYear();
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    return `${month} ${day}, ${year} ${hh}:${mm}:${ss}`;
  }

  private buildRow(alert: WalletAlert): string[] {
    const ts = this.formatTimestamp(alert.timestamp ?? new Date().toISOString());

    switch (alert.kind) {
      case "transfer":
        return this.buildTransferRow(alert, ts);
      case "swap":
        return this.buildSwapRow(alert, ts);
      case "contract_call":
        return this.buildContractCallRow(alert, ts);
    }
  }

  private buildTransferRow(alert: TransferAlert, ts: string): string[] {
    return [
      ts,
      "Transfer",
      alert.wallet.label,
      alert.direction,
      alert.fromAddress,
      alert.toAddress,
      formatCoinList(alert.amounts),
      alert.txHash,
      String(alert.height),
    ];
  }

  private buildSwapRow(alert: SwapAlert, ts: string): string[] {
    const sent = alert.inputToken ? formatTokenDescriptor(alert.inputToken) : "";
    const received = alert.outputToken ? formatTokenDescriptor(alert.outputToken) : "";
    return [
      ts,
      "Swap",
      alert.wallet.label,
      "",
      alert.sender,
      alert.targetContract ?? alert.contract,
      sent && received ? `${sent} → ${received}` : sent || received,
      alert.txHash,
      String(alert.height),
    ];
  }

  private buildContractCallRow(alert: ContractCallAlert, ts: string): string[] {
    return [
      ts,
      "Contract Call",
      alert.wallet.label,
      alert.direction ?? "",
      alert.sender,
      alert.targetContract ?? alert.contract,
      alert.amount && alert.assetLabel ? `${alert.amount} ${alert.assetLabel}` : "",
      alert.txHash,
      String(alert.height),
    ];
  }
}
