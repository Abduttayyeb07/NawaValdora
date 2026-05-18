import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrackedWallet, WalletAlert } from "../types/blockchain";

// ── mock googleapis before importing service ──────────────────────────────────
// vi.mock is hoisted above variable declarations, so all referenced fns must
// come from vi.hoisted(). GoogleAuth must be a regular function (not arrow) so
// it can be called with `new`.

const { MockGoogleAuth, mockAppend, mockBatchUpdate, mockGet, MockSheets } = vi.hoisted(() => {
  const mockAppend      = vi.fn().mockResolvedValue({});
  const mockBatchUpdate = vi.fn().mockResolvedValue({});
  const mockGet         = vi.fn();

  // Must be a regular function — arrow functions cannot be used as constructors.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const MockGoogleAuth  = vi.fn(function MockGoogleAuth() {});

  const MockSheets = vi.fn().mockReturnValue({
    spreadsheets: {
      batchUpdate: mockBatchUpdate,
      get:         mockGet,
      values: {
        append:      mockAppend,
        batchUpdate: mockBatchUpdate,
        get:         vi.fn().mockResolvedValue({ data: { values: [] } }),
      },
    },
  });

  return { MockGoogleAuth, MockSheets, mockAppend, mockBatchUpdate, mockGet };
});

vi.mock("googleapis", () => ({
  google: {
    auth: { GoogleAuth: MockGoogleAuth },
    sheets: MockSheets,
  },
}));

import { GoogleSheetsService } from "../services/googleSheetsService";

// ── fixtures ──────────────────────────────────────────────────────────────────

const VAULT_1: TrackedWallet    = { address: "zig1vault1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "vault",         label: "Stablecoin Yield Vault" };
const VAULT_2: TrackedWallet    = { address: "zig1vault2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "vault",         label: "Quant Strategy Vault" };
const NAWA: TrackedWallet       = { address: "zig1nawaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",  kind: "nawa_usdc",     label: "NAWA" };
const NAWA_ADMIN: TrackedWallet = { address: "zig1nawaadminaaaaaaaaaaaaaaaaaaaaaaaaaa",  kind: "nawa_usdc",     label: "Nawa Admin Wallet" };
const PMP_1: TrackedWallet      = { address: "zig1pmp1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "pmp",           label: "PMP 1" };
const PMP_2: TrackedWallet      = { address: "zig1pmp2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "pmp",           label: "PMP 2" };
const VALDORA: TrackedWallet    = { address: "zig1valdoraaaaaaaaaaaaaaaaaaaaaaaaaaaaa",  kind: "valdora_vault", label: "USDC Opportunistic Credit Vault" };
const SMRWA: TrackedWallet      = { address: "zig1smrwaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "smrwa",         label: "SMRWA Test Wallet" };

const ALL_WALLETS = [VAULT_1, VAULT_2, NAWA, NAWA_ADMIN, PMP_1, PMP_2, VALDORA, SMRWA];

const USDC_DENOM = "ibc/6490A7EAB61059BFC1CDDEB05917DD70BDF3A611654162A1A47DB930D40D8AF4";
const ZIG_DENOM  = "uzig";
const UNTRACKED  = "zig1untrackedaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTRACT   = "zig1contractaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHEET_ID   = "test-spreadsheet-id";

const mockLogger = {
  child: () => mockLogger,
  debug: vi.fn(),
  error: vi.fn(),
  info:  vi.fn(),
  warn:  vi.fn(),
} as never;

function makeTransferAlert(wallet: TrackedWallet, direction: "INFLOW" | "OUTFLOW", overrides: Partial<WalletAlert> = {}): WalletAlert {
  return {
    amounts: [{ amount: "500000000000", denom: USDC_DENOM }],
    direction,
    fromAddress: direction === "INFLOW" ? UNTRACKED : wallet.address,
    height: 8799779,
    kind: "transfer",
    timestamp: "2026-05-18T10:00:00.000Z",
    toAddress: direction === "OUTFLOW" ? UNTRACKED : wallet.address,
    txHash: "DEADBEEF000000000000000000000000",
    wallet,
    ...overrides,
  } as WalletAlert;
}

function makeSwapAlert(wallet: TrackedWallet): WalletAlert {
  return {
    contract: CONTRACT,
    height: 8799800,
    kind: "swap",
    sender: wallet.address,
    timestamp: "2026-05-18T11:00:00.000Z",
    txHash: "SWAPHASH000000000000000000000000",
    wallet,
  };
}

function makeContractCallAlert(wallet: TrackedWallet): WalletAlert {
  return {
    contract: CONTRACT,
    height: 8799900,
    kind: "contract_call",
    sender: wallet.address,
    summary: "withdraw",
    timestamp: "2026-05-18T12:00:00.000Z",
    txHash: "CALLHASH000000000000000000000000",
    wallet,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function capturedRanges(): string[] {
  return mockAppend.mock.calls.map((call) => call[0]?.range as string);
}

function makeService(wallets = ALL_WALLETS): GoogleSheetsService {
  return new GoogleSheetsService({
    credentialsPath: "credentials.json",
    logger: mockLogger,
    spreadsheetId: SHEET_ID,
    trackedWallets: wallets,
  });
}

// Simulate all sheets already existing so initialize() skips creation.
function sheetsExist(wallets: TrackedWallet[]): void {
  mockGet.mockResolvedValue({
    data: {
      sheets: wallets.map((w) => ({ properties: { title: w.label } })),
    },
  });
}

// Simulate no sheets existing so initialize() creates them all.
function noSheetsExist(): void {
  mockGet.mockResolvedValue({ data: { sheets: [] } });
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockAppend.mockResolvedValue({});
  mockBatchUpdate.mockResolvedValue({});
});

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("initialization", () => {
  it("creates all 8 wallet tabs when none exist", async () => {
    noSheetsExist();
    const service = makeService();
    await service.initialize();

    // batchUpdate called once for sheet creation
    const createCall = mockBatchUpdate.mock.calls[0]!;
    const requests = createCall[0].requestBody.requests as Array<{ addSheet: { properties: { title: string } } }>;
    expect(requests).toHaveLength(8);
    const titles = requests.map((r) => r.addSheet.properties.title);
    expect(titles).toContain("Stablecoin Yield Vault");
    expect(titles).toContain("NAWA");
    expect(titles).toContain("PMP 1");
    expect(titles).toContain("USDC Opportunistic Credit Vault");
    expect(titles).toContain("SMRWA Test Wallet");
  });

  it("writes header row to every newly created tab", async () => {
    noSheetsExist();
    const service = makeService();
    await service.initialize();

    // second batchUpdate call is the header write
    const headerCall = mockBatchUpdate.mock.calls[1]!;
    const data = headerCall[0].requestBody.data as Array<{ range: string; values: string[][] }>;
    expect(data).toHaveLength(8);
    for (const entry of data) {
      expect(entry.values[0]).toEqual([
        "Timestamp", "Type", "Wallet", "Direction",
        "From / Sender", "To / Contract", "Amount", "Tx Hash", "Block",
      ]);
    }
  });

  it("skips creation for tabs that already exist", async () => {
    // All tabs already present
    sheetsExist(ALL_WALLETS);
    const service = makeService();
    await service.initialize();

    // batchUpdate should NOT be called (no sheets to create, no headers to write)
    expect(mockBatchUpdate).not.toHaveBeenCalled();
  });

  it("creates only the missing tabs when some already exist", async () => {
    // Only VAULT_1 and NAWA tabs exist
    mockGet.mockResolvedValue({
      data: {
        sheets: [
          { properties: { title: VAULT_1.label } },
          { properties: { title: NAWA.label } },
        ],
      },
    });
    const service = makeService();
    await service.initialize();

    const createCall = mockBatchUpdate.mock.calls[0]!;
    const requests = createCall[0].requestBody.requests as Array<{ addSheet: { properties: { title: string } } }>;
    // 8 total - 2 existing = 6 created
    expect(requests).toHaveLength(6);
    const titles = requests.map((r) => r.addSheet.properties.title);
    expect(titles).not.toContain(VAULT_1.label);
    expect(titles).not.toContain(NAWA.label);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WRITE TO CORRECT SHEET — each wallet writes to its own tab
// ═══════════════════════════════════════════════════════════════════════════════

describe("writeAlert routes to correct sheet", () => {
  async function initService(wallets = ALL_WALLETS): Promise<GoogleSheetsService> {
    sheetsExist(wallets);
    const service = makeService(wallets);
    await service.initialize();
    return service;
  }

  it("VAULT_1 inflow → written to 'Stablecoin Yield Vault' tab", async () => {
    const service = await initService();
    await service.writeAlert(makeTransferAlert(VAULT_1, "INFLOW"));
    expect(capturedRanges()).toContain("'Stablecoin Yield Vault'!A1");
  });

  it("VAULT_2 outflow → written to 'Quant Strategy Vault' tab", async () => {
    const service = await initService();
    await service.writeAlert(makeTransferAlert(VAULT_2, "OUTFLOW"));
    expect(capturedRanges()).toContain("'Quant Strategy Vault'!A1");
  });

  it("NAWA inflow → written to 'NAWA' tab", async () => {
    const service = await initService();
    await service.writeAlert(makeTransferAlert(NAWA, "INFLOW"));
    expect(capturedRanges()).toContain("'NAWA'!A1");
  });

  it("NAWA Admin outflow → written to 'Nawa Admin Wallet' tab", async () => {
    const service = await initService();
    await service.writeAlert(makeTransferAlert(NAWA_ADMIN, "OUTFLOW"));
    expect(capturedRanges()).toContain("'Nawa Admin Wallet'!A1");
  });

  it("PMP 1 inflow → written to 'PMP 1' tab", async () => {
    const service = await initService();
    await service.writeAlert(makeTransferAlert(PMP_1, "INFLOW"));
    expect(capturedRanges()).toContain("'PMP 1'!A1");
  });

  it("PMP 2 outflow → written to 'PMP 2' tab", async () => {
    const service = await initService();
    await service.writeAlert(makeTransferAlert(PMP_2, "OUTFLOW"));
    expect(capturedRanges()).toContain("'PMP 2'!A1");
  });

  it("Valdora inflow → written to 'USDC Opportunistic Credit Vault' tab", async () => {
    const service = await initService();
    await service.writeAlert(makeTransferAlert(VALDORA, "INFLOW"));
    expect(capturedRanges()).toContain("'USDC Opportunistic Credit Vault'!A1");
  });

  it("SMRWA outflow → written to 'SMRWA Test Wallet' tab", async () => {
    const service = await initService();
    await service.writeAlert(makeTransferAlert(SMRWA, "OUTFLOW"));
    expect(capturedRanges()).toContain("'SMRWA Test Wallet'!A1");
  });

  it("swap alert → written to correct wallet tab", async () => {
    const service = await initService();
    await service.writeAlert(makeSwapAlert(VAULT_1));
    expect(capturedRanges()).toContain("'Stablecoin Yield Vault'!A1");
  });

  it("contract call alert → written to correct wallet tab", async () => {
    const service = await initService();
    await service.writeAlert(makeContractCallAlert(NAWA));
    expect(capturedRanges()).toContain("'NAWA'!A1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SHEET 1 IS NEVER WRITTEN TO
// ═══════════════════════════════════════════════════════════════════════════════

describe("Sheet 1 is never written to", () => {
  it("no write goes to the bare 'A1' range (old combined sheet)", async () => {
    sheetsExist(ALL_WALLETS);
    const service = makeService();
    await service.initialize();

    for (const wallet of ALL_WALLETS) {
      await service.writeAlert(makeTransferAlert(wallet, "INFLOW"));
      await service.writeAlert(makeTransferAlert(wallet, "OUTFLOW"));
    }

    const ranges = capturedRanges();
    // Every range must start with a single-quoted sheet name, never bare "A1"
    for (const range of ranges) {
      expect(range).toMatch(/^'.+'/);
      expect(range).not.toBe("A1");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROW CONTENT
// ═══════════════════════════════════════════════════════════════════════════════

describe("row content", () => {
  async function initAndWrite(alert: WalletAlert): Promise<string[]> {
    sheetsExist(ALL_WALLETS);
    const service = makeService();
    await service.initialize();
    await service.writeAlert(alert);
    const lastCall = mockAppend.mock.calls.at(-1)!;
    return lastCall[0].requestBody.values[0] as string[];
  }

  it("transfer row has correct columns", async () => {
    const alert = makeTransferAlert(VAULT_1, "INFLOW");
    const row = await initAndWrite(alert);
    expect(row[1]).toBe("Transfer");
    expect(row[2]).toBe("Stablecoin Yield Vault");
    expect(row[3]).toBe("INFLOW");
    expect(row[7]).toBe(alert.txHash);
    expect(row[8]).toBe(String(alert.height));
  });

  it("transfer OUTFLOW row has OUTFLOW direction", async () => {
    const row = await initAndWrite(makeTransferAlert(NAWA, "OUTFLOW"));
    expect(row[3]).toBe("OUTFLOW");
  });

  it("swap row has correct type and no direction", async () => {
    const row = await initAndWrite(makeSwapAlert(VAULT_2));
    expect(row[1]).toBe("Swap");
    expect(row[3]).toBe("");
  });

  it("contract call row has correct type", async () => {
    const row = await initAndWrite(makeContractCallAlert(PMP_1));
    expect(row[1]).toBe("Contract Call");
    expect(row[2]).toBe("PMP 1");
  });

  it("ZIG transfer amount is formatted in row", async () => {
    const alert = makeTransferAlert(SMRWA, "INFLOW", {
      amounts: [{ amount: "30000000000", denom: ZIG_DENOM }],
    });
    const row = await initAndWrite(alert);
    expect(row[6]).toContain("ZIG");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SAFETY / EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe("safety", () => {
  it("unknown wallet address — no write, no crash", async () => {
    sheetsExist(ALL_WALLETS);
    const service = makeService();
    await service.initialize();

    const unknownWallet: TrackedWallet = { address: "zig1unknownaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "vault", label: "Unknown" };
    const alert = makeTransferAlert(unknownWallet, "INFLOW");
    await service.writeAlert(alert);

    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("writeCount increments once per successful write", async () => {
    sheetsExist(ALL_WALLETS);
    const service = makeService();
    await service.initialize();

    expect(service.getWriteCount()).toBe(0);
    await service.writeAlert(makeTransferAlert(VAULT_1, "INFLOW"));
    await service.writeAlert(makeTransferAlert(NAWA, "OUTFLOW"));
    await service.writeAlert(makeTransferAlert(PMP_1, "INFLOW"));
    expect(service.getWriteCount()).toBe(3);
  });

  it("API failure on writeAlert — logs error without throwing", async () => {
    sheetsExist(ALL_WALLETS);
    const service = makeService();
    await service.initialize();

    mockAppend.mockRejectedValueOnce(new Error("Sheets API quota exceeded"));
    await expect(service.writeAlert(makeTransferAlert(VAULT_1, "INFLOW"))).resolves.not.toThrow();
  });

  it("all 8 wallets write to 8 different tabs in one session", async () => {
    sheetsExist(ALL_WALLETS);
    const service = makeService();
    await service.initialize();

    for (const wallet of ALL_WALLETS) {
      await service.writeAlert(makeTransferAlert(wallet, "INFLOW"));
    }

    const ranges = new Set(capturedRanges());
    expect(ranges.size).toBe(8);
    for (const wallet of ALL_WALLETS) {
      expect(ranges).toContain(`'${wallet.label}'!A1`);
    }
  });
});
