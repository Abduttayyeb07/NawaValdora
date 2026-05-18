import { google } from "googleapis";
import type { Logger } from "pino";

import type { ContractCallAlert, SwapAlert, TransferAlert, TrackedWallet, WalletAlert } from "../types/blockchain";
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

// Wrap sheet names containing spaces/special chars in single quotes for Sheets API range notation.
function sheetRange(name: string, cell = "A1"): string {
  return `'${name}'!${cell}`;
}

export class GoogleSheetsService {
  private readonly logger: Logger;

  private readonly sheets: ReturnType<typeof google.sheets>;

  private readonly spreadsheetId: string;

  private readonly trackedWallets: readonly TrackedWallet[];

  // address → sheet tab name
  private walletSheetMap = new Map<string, string>();

  private writeCount = 0;

  public constructor(options: {
    readonly credentialsPath: string;
    readonly logger: Logger;
    readonly spreadsheetId: string;
    readonly trackedWallets: readonly TrackedWallet[];
  }) {
    this.logger = options.logger.child({ component: "google-sheets" });
    this.spreadsheetId = options.spreadsheetId;
    this.trackedWallets = options.trackedWallets;

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
    // 1. Fetch all existing sheet tab names.
    const meta = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const existingNames = new Set(
      (meta.data.sheets ?? []).map((s) => s.properties?.title ?? ""),
    );

    // 2. Determine which wallet tabs are missing.
    const missing = this.trackedWallets.filter((w) => !existingNames.has(w.label));

    // 3. Create all missing tabs in a single batchUpdate call.
    if (missing.length > 0) {
      await this.sheets.spreadsheets.batchUpdate({
        requestBody: {
          requests: missing.map((w) => ({
            addSheet: { properties: { title: w.label } },
          })),
        },
        spreadsheetId: this.spreadsheetId,
      });

      this.logger.info(
        { sheets: missing.map((w) => w.label) },
        "Created missing wallet sheets",
      );

      // 4. Write header rows to all newly created tabs.
      await this.sheets.spreadsheets.values.batchUpdate({
        requestBody: {
          data: missing.map((w) => ({
            range: sheetRange(w.label, "A1"),
            values: [HEADER_ROW],
          })),
          valueInputOption: "RAW",
        },
        spreadsheetId: this.spreadsheetId,
      });
    }

    // 5. Build address → sheet name lookup.
    for (const wallet of this.trackedWallets) {
      this.walletSheetMap.set(wallet.address, wallet.label);
    }

    this.logger.info(
      { walletCount: this.walletSheetMap.size },
      "Google Sheets per-wallet tabs ready",
    );
  }

  public async writeAlert(alert: WalletAlert): Promise<void> {
    const sheetName = this.walletSheetMap.get(alert.wallet.address);
    if (!sheetName) {
      this.logger.warn(
        { address: alert.wallet.address },
        "No sheet tab found for wallet address — skipping write",
      );
      return;
    }

    try {
      const row = this.buildRow(alert);
      await this.sheets.spreadsheets.values.append({
        range: sheetRange(sheetName, "A1"),
        requestBody: { values: [row] },
        spreadsheetId: this.spreadsheetId,
        valueInputOption: "RAW",
      });
      this.writeCount += 1;
      this.logger.info(
        { height: alert.height, sheet: sheetName, txHash: alert.txHash, writeCount: this.writeCount },
        "Alert written to wallet sheet",
      );
    } catch (error) {
      this.logger.error(
        { error, height: alert.height, sheet: sheetName, txHash: alert.txHash },
        "Failed to write alert to wallet sheet",
      );
    }
  }

  private formatTimestamp(raw: string): string {
    const d = new Date(raw);
    const month = d.toLocaleString("en-US", { month: "long", timeZone: "Asia/Karachi" });
    const day = d.toLocaleString("en-US", { day: "2-digit", timeZone: "Asia/Karachi" });
    const year = d.toLocaleString("en-US", { year: "numeric", timeZone: "Asia/Karachi" });
    const time = d.toLocaleString("en-US", { hour: "2-digit", hour12: false, minute: "2-digit", second: "2-digit", timeZone: "Asia/Karachi" });
    return `${month} ${day}, ${year} ${time}`;
  }

  private buildRow(alert: WalletAlert): string[] {
    const ts = this.formatTimestamp(alert.timestamp ?? new Date().toISOString());

    switch (alert.kind) {
      case "transfer":      return this.buildTransferRow(alert, ts);
      case "swap":          return this.buildSwapRow(alert, ts);
      case "contract_call": return this.buildContractCallRow(alert, ts);
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
    const sent     = alert.inputToken  ? formatTokenDescriptor(alert.inputToken)  : "";
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
