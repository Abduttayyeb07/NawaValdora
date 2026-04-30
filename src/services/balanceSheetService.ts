import { google } from "googleapis";
import type { Logger } from "pino";

import type { TrackedWallet } from "../types/blockchain";
import type { BalanceService, WalletBalance } from "./balanceService";

// PKT = UTC+5
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

// 12:00 PM PKT = 07:00 UTC, 9:00 PM PKT = 16:00 UTC
const SNAPSHOT_UTC_TIMES: [number, number][] = [[7, 0], [16, 0]];

// Column A holds wallet labels; date columns start at B (index 1)
const DATE_COL_START = 1;

// Wallet rows start at row 2 (row 1 is the date header)
const WALLET_ROW_START = 2;

function pktDateLabel(): string {
  const pkt = new Date(Date.now() + PKT_OFFSET_MS);
  return `${pkt.getUTCMonth() + 1}-${pkt.getUTCDate()}`;
}

function toColLetter(index: number): string {
  let letter = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(rem + 65) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

function formatBalance(zig: number, usdc: number): string {
  return `${zig.toFixed(2)} ZIG / ${usdc.toFixed(2)} USDC`;
}

function msUntilNextUtcTime(hour: number, minute: number): number {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export class BalanceSheetService {
  private readonly balanceService: BalanceService;

  private readonly broadcastMessage: ((message: string) => Promise<void>) | null;

  private readonly gid: number;

  private readonly logger: Logger;

  private sheetName = "";

  private readonly sheets: ReturnType<typeof google.sheets>;

  private readonly spreadsheetId: string;

  private readonly timers: NodeJS.Timeout[] = [];

  private readonly trackedWallets: readonly TrackedWallet[];

  public constructor(options: {
    readonly balanceService: BalanceService;
    readonly broadcastMessage?: (message: string) => Promise<void>;
    readonly credentialsPath: string;
    readonly gid: number;
    readonly logger: Logger;
    readonly spreadsheetId: string;
    readonly trackedWallets: readonly TrackedWallet[];
  }) {
    this.balanceService = options.balanceService;
    this.broadcastMessage = options.broadcastMessage ?? null;
    this.gid = options.gid;
    this.logger = options.logger.child({ component: "balance-sheet" });
    this.spreadsheetId = options.spreadsheetId;
    this.trackedWallets = options.trackedWallets;

    const auth = new google.auth.GoogleAuth({
      keyFile: options.credentialsPath,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.sheets = google.sheets({ version: "v4", auth });
  }

  public async initialize(): Promise<void> {
    const meta = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const sheet = (meta.data.sheets ?? []).find((s) => s.properties?.sheetId === this.gid);

    if (!sheet?.properties?.title) {
      throw new Error(`Balance sheet with gid ${this.gid} not found in spreadsheet`);
    }

    this.sheetName = sheet.properties.title;
    this.logger.info({ sheetName: this.sheetName }, "Balance sheet ready");
  }

  public start(): void {
    for (const [hour, minute] of SNAPSHOT_UTC_TIMES) {
      const pktHour = (hour + 5) % 24;
      const ms = msUntilNextUtcTime(hour, minute);
      this.logger.info(
        { firstRunInMs: ms, schedule: `${pktHour}:${String(minute).padStart(2, "0")} PKT` },
        "Balance snapshot scheduled",
      );
      this.scheduleNext(hour, minute);
    }
  }

  public stop(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.length = 0;
  }

  public async runSnapshot(): Promise<void> {
    const dateLabel = pktDateLabel();
    this.logger.info({ dateLabel }, "Running balance snapshot");

    try {
      const colIndex = await this.findOrCreateDateColumn(dateLabel);
      const colLetter = toColLetter(colIndex);

      const vaultWallets = this.trackedWallets.filter((w) => w.kind === "vault");
      const nawaWallet = this.trackedWallets.find((w) => w.kind === "nawa_usdc");

      // Nawa row skips one blank row after the vault wallets
      const nawaRow = WALLET_ROW_START + vaultWallets.length + 1;

      const data: Array<{ range: string; values: string[][] }> = [];
      const reportLines: string[] = [`📊 <b>Balance Report — ${dateLabel}</b>`, ""];

      for (let i = 0; i < vaultWallets.length; i++) {
        const wallet = vaultWallets[i];
        if (!wallet) continue;
        const row = WALLET_ROW_START + i;
        const balance = await this.safeFetch(wallet.address);
        data.push({
          range: `${this.sheetName}!${colLetter}${row}`,
          values: [[formatBalance(balance.zig, balance.usdc)]],
        });
        reportLines.push(`<b>${wallet.label}</b>`);
        reportLines.push(`  ZIG: ${balance.zig.toFixed(2)}`);
        reportLines.push(`  USDC: ${balance.usdc.toFixed(2)}`);
      }

      if (nawaWallet) {
        const balance = await this.safeFetch(nawaWallet.address);
        data.push({
          range: `${this.sheetName}!${colLetter}${nawaRow}`,
          values: [[formatBalance(balance.zig, balance.usdc)]],
        });
        reportLines.push("");
        reportLines.push(`<b>${nawaWallet.label}</b>`);
        reportLines.push(`  ZIG: ${balance.zig.toFixed(2)}`);
        reportLines.push(`  USDC: ${balance.usdc.toFixed(2)}`);
      }

      await this.sheets.spreadsheets.values.batchUpdate({
        requestBody: { data, valueInputOption: "RAW" },
        spreadsheetId: this.spreadsheetId,
      });

      this.logger.info(
        { colLetter, dateLabel, walletCount: data.length },
        "Balance snapshot written",
      );

      if (this.broadcastMessage) {
        await this.broadcastMessage(reportLines.join("\n"));
      }
    } catch (error) {
      this.logger.error({ error }, "Balance snapshot failed");
    }
  }

  private scheduleNext(utcHour: number, utcMinute: number): void {
    const ms = msUntilNextUtcTime(utcHour, utcMinute);
    const timer = setTimeout(() => {
      void this.runSnapshot();
      this.scheduleNext(utcHour, utcMinute);
    }, ms);
    this.timers.push(timer);
  }

  private async findOrCreateDateColumn(dateLabel: string): Promise<number> {
    const response = await this.sheets.spreadsheets.values.get({
      range: `${this.sheetName}!B1:ZZ1`,
      spreadsheetId: this.spreadsheetId,
    });

    const headers = (response.data.values?.[0] ?? []) as string[];
    const existing = headers.indexOf(dateLabel);

    if (existing !== -1) {
      return DATE_COL_START + existing;
    }

    const newColIndex = DATE_COL_START + headers.length;
    const newColLetter = toColLetter(newColIndex);

    await this.sheets.spreadsheets.values.update({
      range: `${this.sheetName}!${newColLetter}1`,
      requestBody: { values: [[dateLabel]] },
      spreadsheetId: this.spreadsheetId,
      valueInputOption: "RAW",
    });

    this.logger.info({ dateLabel, newColLetter }, "Created new date column in balance sheet");
    return newColIndex;
  }

  private async safeFetch(address: string): Promise<WalletBalance> {
    try {
      return await this.balanceService.fetchBalance(address);
    } catch (error) {
      this.logger.error({ address, error }, "Balance fetch failed; writing zeros");
      return { address, usdc: 0, zig: 0 };
    }
  }
}
