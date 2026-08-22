import { google } from "googleapis";
import type { Logger } from "pino";

import type { TrackedWallet } from "../types/blockchain";
import type { BalanceService, WalletBalance } from "./balanceService";

// PKT = UTC+5
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

// 9:00 AM PKT = 04:00 UTC, 12:00 PM PKT = 07:00 UTC
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Sheets timeout: ${label}`)), ms),
    ),
  ]);
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

  public async fetchBalanceReport(): Promise<string> {
    const dateLabel = pktDateLabel();
    const lines: string[] = [`📊 <b>Balance Report — ${dateLabel}</b>`];
    await this.appendWalletGroup(lines, "valdora_vault");
    await this.appendWalletGroup(lines, "nawa_usdc");
    await this.appendWalletGroup(lines, "pmp");
    await this.appendWalletGroup(lines, "vault");
    await this.appendWalletGroup(lines, "smrwa");
    return lines.join("\n");
  }

  private static groupHeader(kind: TrackedWallet["kind"]): string {
    const headers: Record<TrackedWallet["kind"], string> = {
      nawa_usdc: "💼 NAWA",
      pmp: "📈 PMP",
      smrwa: "🧪 SMRWA",
      valdora_vault: "🏛 Valdora Vaults",
      vault: "🔷 Vaults",
    };
    return `<b>${headers[kind]}</b>`;
  }

  private async appendWalletGroup(lines: string[], kind: TrackedWallet["kind"]): Promise<void> {
    const wallets = this.trackedWallets.filter((w) => w.kind === kind);
    if (wallets.length === 0) return;
    lines.push("", BalanceSheetService.groupHeader(kind));
    for (const wallet of wallets) {
      const balance = await this.safeFetch(wallet.address);
      lines.push(`<b>${wallet.label}</b>`);
      lines.push(`<b>ZIG</b> <code>${balance.zig.toFixed(2)}</code>  ·  <b>USDC</b> <code>${balance.usdc.toFixed(2)}</code>`);
    }
  }

  public async runSnapshot(): Promise<void> {
    const dateLabel = pktDateLabel();
    this.logger.info({ dateLabel }, "Running balance snapshot");

    // ── Step 1: fetch all balances from LCD ──────────────────────────────────
    const valdoraWallets = this.trackedWallets.filter((w) => w.kind === "valdora_vault");
    const nawaWallets    = this.trackedWallets.filter((w) => w.kind === "nawa_usdc");
    const pmpWallets     = this.trackedWallets.filter((w) => w.kind === "pmp");
    const vaultWallets   = this.trackedWallets.filter((w) => w.kind === "vault");
    const smrwaWallet    = this.trackedWallets.find((w) => w.kind === "smrwa");

    type WalletBalance = { zig: number; usdc: number };
    const balances = new Map<string, WalletBalance>();
    for (const w of this.trackedWallets) {
      balances.set(w.address, await this.safeFetch(w.address));
    }

    // ── Step 2: build Telegram report and send immediately ───────────────────
    const reportLines: string[] = [`📊 <b>Balance Report — ${dateLabel}</b>`];

    const appendGroup = (wallets: readonly typeof valdoraWallets[number][], kind: TrackedWallet["kind"]): void => {
      if (wallets.length === 0) return;
      reportLines.push("", BalanceSheetService.groupHeader(kind));
      for (const wallet of wallets) {
        const b = balances.get(wallet.address) ?? { zig: 0, usdc: 0 };
        reportLines.push(`<b>${wallet.label}</b>`);
        reportLines.push(`<code>ZIG  ${b.zig.toFixed(2)}   USDC  ${b.usdc.toFixed(2)}</code>`);
      }
    };

    appendGroup(valdoraWallets, "valdora_vault");
    appendGroup(nawaWallets,    "nawa_usdc");
    appendGroup(pmpWallets,     "pmp");
    appendGroup(vaultWallets,   "vault");
    if (smrwaWallet) {
      const b = balances.get(smrwaWallet.address) ?? { zig: 0, usdc: 0 };
      reportLines.push("", BalanceSheetService.groupHeader("smrwa"));
      reportLines.push(`<b>${smrwaWallet.label}</b>`);
      reportLines.push(`<code>ZIG  ${b.zig.toFixed(2)}   USDC  ${b.usdc.toFixed(2)}</code>`);
    }

    if (this.broadcastMessage) {
      try {
        await this.broadcastMessage(reportLines.join("\n"));
        this.logger.info({ dateLabel }, "Balance report broadcast sent");
      } catch (error) {
        this.logger.error({ error }, "Balance report broadcast failed");
      }
    }

    // ── Step 3: write to Sheets independently (failure never blocks Telegram) ─
    try {
      const VD = valdoraWallets.length;
      const N  = nawaWallets.length;
      const P  = pmpWallets.length;
      const V  = vaultWallets.length;
      const nawaStartRow  = WALLET_ROW_START + VD + 1;
      const pmpStartRow   = nawaStartRow + N + 1;
      const vaultStartRow = pmpStartRow + P + 1;
      const smrwaRow      = vaultStartRow + V + 1;

      const colIndex  = await this.findOrCreateDateColumn(dateLabel);
      const colLetter = toColLetter(colIndex);

      const data: Array<{ range: string; values: string[][] }> = [];
      valdoraWallets.forEach((w, i) => {
        const b = balances.get(w.address) ?? { zig: 0, usdc: 0 };
        data.push({ range: `${this.sheetName}!${colLetter}${WALLET_ROW_START + i}`, values: [[formatBalance(b.zig, b.usdc)]] });
      });
      nawaWallets.forEach((w, i) => {
        const b = balances.get(w.address) ?? { zig: 0, usdc: 0 };
        data.push({ range: `${this.sheetName}!${colLetter}${nawaStartRow + i}`, values: [[formatBalance(b.zig, b.usdc)]] });
      });
      pmpWallets.forEach((w, i) => {
        const b = balances.get(w.address) ?? { zig: 0, usdc: 0 };
        data.push({ range: `${this.sheetName}!${colLetter}${pmpStartRow + i}`, values: [[formatBalance(b.zig, b.usdc)]] });
      });
      vaultWallets.forEach((w, i) => {
        const b = balances.get(w.address) ?? { zig: 0, usdc: 0 };
        data.push({ range: `${this.sheetName}!${colLetter}${vaultStartRow + i}`, values: [[formatBalance(b.zig, b.usdc)]] });
      });
      if (smrwaWallet) {
        const b = balances.get(smrwaWallet.address) ?? { zig: 0, usdc: 0 };
        data.push({ range: `${this.sheetName}!${colLetter}${smrwaRow}`, values: [[formatBalance(b.zig, b.usdc)]] });
      }

      await withTimeout(
        this.sheets.spreadsheets.values.batchUpdate({
          requestBody: { data, valueInputOption: "RAW" },
          spreadsheetId: this.spreadsheetId,
        }),
        20_000,
        "batchUpdate balances",
      );
      this.logger.info({ colLetter, dateLabel, walletCount: data.length }, "Balance snapshot written to Sheets");
    } catch (error) {
      this.logger.error({ error }, "Balance snapshot Sheets write failed");
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
    const response = await withTimeout(
      this.sheets.spreadsheets.values.get({
        range: `${this.sheetName}!B1:ZZ1`,
        spreadsheetId: this.spreadsheetId,
      }),
      20_000,
      "values.get header row",
    );

    const headers = (response.data.values?.[0] ?? []) as string[];
    const existing = headers.indexOf(dateLabel);

    if (existing !== -1) {
      return DATE_COL_START + existing;
    }

    const newColIndex = DATE_COL_START + headers.length;
    const newColLetter = toColLetter(newColIndex);

    // Sheets grids default to 26 columns. Expand by 50 whenever we're about
    // to write beyond the current boundary so we never hit the limit again.
    const meta = await withTimeout(
      this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId }),
      20_000,
      "spreadsheets.get column count",
    );
    const sheetMeta = (meta.data.sheets ?? []).find((s) => s.properties?.sheetId === this.gid);
    const currentCols = sheetMeta?.properties?.gridProperties?.columnCount ?? 26;

    if (newColIndex >= currentCols) {
      await withTimeout(
        this.sheets.spreadsheets.batchUpdate({
          requestBody: {
            requests: [{
              updateSheetProperties: {
                fields: "gridProperties.columnCount",
                properties: {
                  gridProperties: { columnCount: newColIndex + 50 },
                  sheetId: this.gid,
                },
              },
            }],
          },
          spreadsheetId: this.spreadsheetId,
        }),
        20_000,
        "batchUpdate expand columns",
      );
      this.logger.info({ newColCount: newColIndex + 50 }, "Expanded balance sheet column count");
    }

    await withTimeout(
      this.sheets.spreadsheets.values.update({
        range: `${this.sheetName}!${newColLetter}1`,
        requestBody: { values: [[dateLabel]] },
        spreadsheetId: this.spreadsheetId,
        valueInputOption: "RAW",
      }),
      20_000,
      "values.update date header",
    );

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
