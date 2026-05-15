import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationService } from "../services/notificationService";
import { TransactionMonitorService } from "../services/transactionMonitorService";
import type { ParsedTransaction, TrackedWallet, WalletAlert } from "../types/blockchain";

// ── wallet fixtures ───────────────────────────────────────────────────────────

const VAULT_1: TrackedWallet    = { address: "zig1vault1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "vault",        label: "Stablecoin Yield Vault" };
const VAULT_2: TrackedWallet    = { address: "zig1vault2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "vault",        label: "Quant Strategy Vault" };
const NAWA: TrackedWallet       = { address: "zig1nawaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",  kind: "nawa_usdc",    label: "NAWA" };
const NAWA_ADMIN: TrackedWallet = { address: "zig1nawaadminaaaaaaaaaaaaaaaaaaaaaaaaaa",  kind: "nawa_usdc",    label: "Nawa Admin Wallet" };
const PMP_1: TrackedWallet      = { address: "zig1pmp1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "pmp",          label: "PMP 1" };
const PMP_2: TrackedWallet      = { address: "zig1pmp2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "pmp",          label: "PMP 2" };
const VALDORA: TrackedWallet    = { address: "zig1valdoraaaaaaaaaaaaaaaaaaaaaaaaaaaaa",  kind: "valdora_vault",label: "Valdora Vault" };
const SMRWA: TrackedWallet      = { address: "zig1smrwaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "smrwa",        label: "SMRWA Test Wallet" };

const ALL_WALLETS = [VAULT_1, VAULT_2, NAWA, NAWA_ADMIN, PMP_1, PMP_2, VALDORA, SMRWA];

const UNTRACKED    = "zig1untrackedaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UNTRACKED_2  = "zig1untracked2aaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTRACT     = "zig1contractaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOBLE_BRIDGE = "noble15xt7kx5mles58vkkfxvf0lq78sw04jajvfgd4d";
const USDC_DENOM   = "ibc/6490A7EAB61059BFC1CDDEB05917DD70BDF3A611654162A1A47DB930D40D8AF4";
const ZIG_DENOM    = "uzig";

// ── helpers ───────────────────────────────────────────────────────────────────

const mockLogger = {
  child: () => mockLogger,
  debug: vi.fn(),
  error: vi.fn(),
  info:  vi.fn(),
  warn:  vi.fn(),
} as never;

function makeTx(overrides: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return { code: 0, fee: [], hash: "DEADBEEF", height: 1000, messages: [], rawEvents: [], ...overrides };
}

function direction(alert: WalletAlert): string | null {
  return alert.kind !== "swap" ? alert.direction ?? null : null;
}

// ── setup ─────────────────────────────────────────────────────────────────────

let alerts: WalletAlert[];
let service: TransactionMonitorService;

beforeEach(() => {
  alerts = [];
  const mockNotification = {
    sendAlert: vi.fn(async (alert: WalletAlert) => { alerts.push(alert); }),
  } as unknown as NotificationService;

  service = new TransactionMonitorService({
    logger: mockLogger,
    notificationService: mockNotification,
    trackedWallets: ALL_WALLETS,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OUTFLOW TESTS (15)
// ═══════════════════════════════════════════════════════════════════════════════

describe("outflows", () => {
  it("O-01  vault MsgSend → external (ZIG)", async () => {
    await service.handleTransaction(makeTx({
      hash: "O01",
      messages: [{ amounts: [{ amount: "5000000", denom: ZIG_DENOM }], fromAddress: VAULT_1.address, kind: "transfer", toAddress: UNTRACKED, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VAULT_1.address);
    expect(direction(alerts[0]!)).toBe("OUTFLOW");
  });

  it("O-02  vault IBC bridge-out to Noble (USDC)", async () => {
    await service.handleTransaction(makeTx({
      hash: "O02",
      messages: [{ amounts: [{ amount: "499999000000", denom: USDC_DENOM }], fromAddress: VAULT_1.address, kind: "transfer", toAddress: NOBLE_BRIDGE, typeUrl: "/ibc.applications.transfer.v1.MsgTransfer" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VAULT_1.address);
    expect(direction(alerts[0]!)).toBe("OUTFLOW");
  });

  it("O-03  NAWA wallet IBC bridge-out (500k USDC — mirrors real tx)", async () => {
    await service.handleTransaction(makeTx({
      hash: "O03",
      messages: [{ amounts: [{ amount: "500000000000", denom: USDC_DENOM }], fromAddress: NAWA.address, kind: "transfer", toAddress: NOBLE_BRIDGE, typeUrl: "/ibc.applications.transfer.v1.MsgTransfer" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(NAWA.address);
    expect(direction(alerts[0]!)).toBe("OUTFLOW");
  });

  it("O-04  Valdora IBC bridge-out (USDC)", async () => {
    await service.handleTransaction(makeTx({
      hash: "O04",
      messages: [{ amounts: [{ amount: "800000000000", denom: USDC_DENOM }], fromAddress: VALDORA.address, kind: "transfer", toAddress: NOBLE_BRIDGE, typeUrl: "/ibc.applications.transfer.v1.MsgTransfer" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VALDORA.address);
    expect(direction(alerts[0]!)).toBe("OUTFLOW");
  });

  it("O-05  PMP-1 MsgSend → external", async () => {
    await service.handleTransaction(makeTx({
      hash: "O05",
      messages: [{ amounts: [{ amount: "1000000", denom: ZIG_DENOM }], fromAddress: PMP_1.address, kind: "transfer", toAddress: UNTRACKED, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(PMP_1.address);
    expect(direction(alerts[0]!)).toBe("OUTFLOW");
  });

  it("O-06  PMP-2 IBC bridge-out", async () => {
    await service.handleTransaction(makeTx({
      hash: "O06",
      messages: [{ amounts: [{ amount: "250000000000", denom: USDC_DENOM }], fromAddress: PMP_2.address, kind: "transfer", toAddress: NOBLE_BRIDGE, typeUrl: "/ibc.applications.transfer.v1.MsgTransfer" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(PMP_2.address);
    expect(direction(alerts[0]!)).toBe("OUTFLOW");
  });

  it("O-07  NAWA Admin MsgSend outflow", async () => {
    await service.handleTransaction(makeTx({
      hash: "O07",
      messages: [{ amounts: [{ amount: "2000000", denom: ZIG_DENOM }], fromAddress: NAWA_ADMIN.address, kind: "transfer", toAddress: UNTRACKED, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(NAWA_ADMIN.address);
    expect(direction(alerts[0]!)).toBe("OUTFLOW");
  });

  it("O-08  SMRWA MsgSend outflow", async () => {
    await service.handleTransaction(makeTx({
      hash: "O08",
      messages: [{ amounts: [{ amount: "500000", denom: ZIG_DENOM }], fromAddress: SMRWA.address, kind: "transfer", toAddress: UNTRACKED, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(SMRWA.address);
    expect(direction(alerts[0]!)).toBe("OUTFLOW");
  });

  it("O-09  vault swap outflow (MsgExecuteContract)", async () => {
    await service.handleTransaction(makeTx({
      hash: "O09",
      messages: [{ contract: CONTRACT, decodedMsg: { swap: {} }, funds: [{ amount: "10000000", denom: ZIG_DENOM }], kind: "swap", rawPayload: '{"swap":{}}', sender: VAULT_2.address, swapAction: "swap", typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("swap");
    expect(alerts[0]?.wallet.address).toBe(VAULT_2.address);
  });

  it("O-10  vault contract withdraw call", async () => {
    await service.handleTransaction(makeTx({
      hash: "O10",
      messages: [{ contract: CONTRACT, decodedMsg: { withdraw: {} }, funds: [], kind: "contract_call", rawPayload: '{"withdraw":{}}', sender: VAULT_1.address, summary: "withdraw", typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("contract_call");
    expect(alerts[0]?.wallet.address).toBe(VAULT_1.address);
  });

  it("O-11  event-only outflow — unknown message type caught by raw events", async () => {
    // No parsed messages (simulates a message type the parser doesn't know about).
    // The raw transfer event is the only signal.
    await service.handleTransaction(makeTx({
      hash: "O11",
      messages: [],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "sender",    value: VAULT_1.address },
          { key: "recipient", value: UNTRACKED },
          { key: "amount",    value: `100000000${USDC_DENOM}` },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VAULT_1.address);
    expect(direction(alerts[0]!)).toBe("OUTFLOW");
  });

  it("O-12  event-only outflow for Valdora (unknown message type)", async () => {
    await service.handleTransaction(makeTx({
      hash: "O12",
      messages: [],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "sender",    value: VALDORA.address },
          { key: "recipient", value: NOBLE_BRIDGE },
          { key: "amount",    value: `300000000000${USDC_DENOM}` },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VALDORA.address);
    expect(direction(alerts[0]!)).toBe("OUTFLOW");
  });

  it("O-13  two vaults each send in the same tx — two outflow alerts", async () => {
    await service.handleTransaction(makeTx({
      hash: "O13",
      messages: [
        { amounts: [{ amount: "1000000", denom: ZIG_DENOM }], fromAddress: VAULT_1.address, kind: "transfer", toAddress: UNTRACKED,   typeUrl: "/cosmos.bank.v1beta1.MsgSend" },
        { amounts: [{ amount: "2000000", denom: ZIG_DENOM }], fromAddress: VAULT_2.address, kind: "transfer", toAddress: UNTRACKED_2, typeUrl: "/cosmos.bank.v1beta1.MsgSend" },
      ],
    }));
    expect(alerts).toHaveLength(2);
    const wallets = alerts.map((a) => a.wallet.address);
    expect(wallets).toContain(VAULT_1.address);
    expect(wallets).toContain(VAULT_2.address);
    alerts.forEach((a) => expect(direction(a)).toBe("OUTFLOW"));
  });

  it("O-14  vault → vault transfer — sender side is OUTFLOW", async () => {
    await service.handleTransaction(makeTx({
      hash: "O14",
      messages: [{ amounts: [{ amount: "1000000", denom: ZIG_DENOM }], fromAddress: VAULT_1.address, kind: "transfer", toAddress: VAULT_2.address, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
    }));
    const outflow = alerts.find((a) => a.wallet.address === VAULT_1.address);
    expect(outflow).toBeDefined();
    expect(direction(outflow!)).toBe("OUTFLOW");
  });

  it("O-15  failed tx (code != 0) never fires outflow — even with events", async () => {
    await service.handleTransaction(makeTx({
      hash: "O15",
      code: 1,
      messages: [{ amounts: [{ amount: "999000000", denom: USDC_DENOM }], fromAddress: VAULT_1.address, kind: "transfer", toAddress: NOBLE_BRIDGE, typeUrl: "/ibc.applications.transfer.v1.MsgTransfer" }],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "sender",    value: VAULT_1.address },
          { key: "recipient", value: NOBLE_BRIDGE },
          { key: "amount",    value: `999000000${USDC_DENOM}` },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INFLOW TESTS (15)
// ═══════════════════════════════════════════════════════════════════════════════

describe("inflows", () => {
  it("I-01  MsgSend → Vault 1 (ZIG)", async () => {
    await service.handleTransaction(makeTx({
      hash: "I01",
      messages: [{ amounts: [{ amount: "10000000", denom: ZIG_DENOM }], fromAddress: UNTRACKED, kind: "transfer", toAddress: VAULT_1.address, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VAULT_1.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("I-02  MsgSend → NAWA (USDC)", async () => {
    await service.handleTransaction(makeTx({
      hash: "I02",
      messages: [{ amounts: [{ amount: "440000000", denom: USDC_DENOM }], fromAddress: UNTRACKED, kind: "transfer", toAddress: NAWA.address, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(NAWA.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("I-03  MsgSend → NAWA Admin (USDC)", async () => {
    await service.handleTransaction(makeTx({
      hash: "I03",
      messages: [{ amounts: [{ amount: "10000000", denom: USDC_DENOM }], fromAddress: UNTRACKED, kind: "transfer", toAddress: NAWA_ADMIN.address, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(NAWA_ADMIN.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("I-04  MsgSend → PMP-1", async () => {
    await service.handleTransaction(makeTx({
      hash: "I04",
      messages: [{ amounts: [{ amount: "5000000", denom: ZIG_DENOM }], fromAddress: UNTRACKED, kind: "transfer", toAddress: PMP_1.address, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(PMP_1.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("I-05  MsgSend → PMP-2", async () => {
    await service.handleTransaction(makeTx({
      hash: "I05",
      messages: [{ amounts: [{ amount: "5000000", denom: ZIG_DENOM }], fromAddress: UNTRACKED, kind: "transfer", toAddress: PMP_2.address, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(PMP_2.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("I-06  MsgSend → Valdora", async () => {
    await service.handleTransaction(makeTx({
      hash: "I06",
      messages: [{ amounts: [{ amount: "500000000000", denom: USDC_DENOM }], fromAddress: UNTRACKED, kind: "transfer", toAddress: VALDORA.address, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VALDORA.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("I-07  MsgSend → SMRWA", async () => {
    await service.handleTransaction(makeTx({
      hash: "I07",
      messages: [{ amounts: [{ amount: "1000000", denom: ZIG_DENOM }], fromAddress: UNTRACKED, kind: "transfer", toAddress: SMRWA.address, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(SMRWA.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("I-08  IBC MsgTransfer → Vault 1 (USDC bridge-in)", async () => {
    await service.handleTransaction(makeTx({
      hash: "I08",
      messages: [{ amounts: [{ amount: "1299999000000", denom: USDC_DENOM }], fromAddress: UNTRACKED, kind: "transfer", toAddress: VAULT_1.address, typeUrl: "/ibc.applications.transfer.v1.MsgTransfer" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VAULT_1.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("I-09  IBC MsgTransfer → Valdora (500k USDC — mirrors real tx)", async () => {
    await service.handleTransaction(makeTx({
      hash: "I09",
      messages: [{ amounts: [{ amount: "500000000000", denom: USDC_DENOM }], fromAddress: UNTRACKED, kind: "transfer", toAddress: VALDORA.address, typeUrl: "/ibc.applications.transfer.v1.MsgTransfer" }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VALDORA.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("I-10  contract deposit → NAWA via events only (the original missed-alert bug)", async () => {
    await service.handleTransaction(makeTx({
      hash: "I10",
      messages: [{ contract: CONTRACT, decodedMsg: { deposit: {} }, funds: [{ amount: "440000000", denom: USDC_DENOM }], kind: "contract_call", rawPayload: '{"deposit":{}}', sender: UNTRACKED, summary: "deposit", typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract" }],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "sender",    value: CONTRACT },
          { key: "recipient", value: NAWA.address },
          { key: "amount",    value: `440000000${USDC_DENOM}` },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(NAWA.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("I-11  contract deposit → Vault via events only", async () => {
    await service.handleTransaction(makeTx({
      hash: "I11",
      messages: [{ contract: CONTRACT, decodedMsg: { deposit: {} }, funds: [], kind: "contract_call", rawPayload: '{"deposit":{}}', sender: UNTRACKED, summary: "deposit", typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract" }],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "sender",    value: CONTRACT },
          { key: "recipient", value: VAULT_2.address },
          { key: "amount",    value: `1299999000000${USDC_DENOM}` },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VAULT_2.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("I-12  event-only inflow — unknown message type caught by raw events", async () => {
    // No parsed messages at all — simulates a future/unknown message type.
    await service.handleTransaction(makeTx({
      hash: "I12",
      messages: [],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "sender",    value: UNTRACKED },
          { key: "recipient", value: NAWA_ADMIN.address },
          { key: "amount",    value: `50000000${USDC_DENOM}` },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(NAWA_ADMIN.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("I-13  multi-event tx (fee split) — one INFLOW, not duplicated", async () => {
    // Chain emits multiple transfer events for the same recipient (e.g. fee routing).
    // We should get exactly one consolidated alert, not one per event.
    await service.handleTransaction(makeTx({
      hash: "I13",
      messages: [],
      rawEvents: [
        { type: "transfer", attributes: [{ key: "sender", value: UNTRACKED }, { key: "recipient", value: VAULT_1.address }, { key: "amount", value: `300000000${USDC_DENOM}` }] },
        { type: "transfer", attributes: [{ key: "sender", value: UNTRACKED }, { key: "recipient", value: VAULT_1.address }, { key: "amount", value: `200000000${USDC_DENOM}` }] },
      ],
    }));
    // Same sender→recipient pair, so flows map consolidates — one alert
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VAULT_1.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("I-14  vault → vault — receiver side is INFLOW", async () => {
    await service.handleTransaction(makeTx({
      hash: "I14",
      messages: [{ amounts: [{ amount: "1000000", denom: ZIG_DENOM }], fromAddress: VAULT_1.address, kind: "transfer", toAddress: VAULT_2.address, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
    }));
    const inflow = alerts.find((a) => a.wallet.address === VAULT_2.address);
    expect(inflow).toBeDefined();
    expect(direction(inflow!)).toBe("INFLOW");
  });

  it("I-15  same tx: VAULT_1 outflow + SMRWA inflow from event (two different signals)", async () => {
    await service.handleTransaction(makeTx({
      hash: "I15",
      messages: [{ amounts: [{ amount: "1000000", denom: ZIG_DENOM }], fromAddress: VAULT_1.address, kind: "transfer", toAddress: UNTRACKED, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "sender",    value: CONTRACT },
          { key: "recipient", value: SMRWA.address },
          { key: "amount",    value: `10000000${USDC_DENOM}` },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(2);
    const wallets = alerts.map((a) => a.wallet.address);
    expect(wallets).toContain(VAULT_1.address);
    expect(wallets).toContain(SMRWA.address);
    const outflow = alerts.find((a) => a.wallet.address === VAULT_1.address);
    const inflow  = alerts.find((a) => a.wallet.address === SMRWA.address);
    expect(direction(outflow!)).toBe("OUTFLOW");
    expect(direction(inflow!)).toBe("INFLOW");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEDUPLICATION — no double-alerts
// ═══════════════════════════════════════════════════════════════════════════════

describe("deduplication", () => {
  it("message + matching event → exactly one alert, not two", async () => {
    await service.handleTransaction(makeTx({
      hash: "DUP1",
      messages: [{ amounts: [{ amount: "1000000", denom: ZIG_DENOM }], fromAddress: UNTRACKED, kind: "transfer", toAddress: VAULT_1.address, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "sender",    value: UNTRACKED },
          { key: "recipient", value: VAULT_1.address },
          { key: "amount",    value: "1000000uzig" },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(1);
  });

  it("IBC message + matching event → exactly one outflow", async () => {
    await service.handleTransaction(makeTx({
      hash: "DUP2",
      messages: [{ amounts: [{ amount: "499999000000", denom: USDC_DENOM }], fromAddress: VALDORA.address, kind: "transfer", toAddress: NOBLE_BRIDGE, typeUrl: "/ibc.applications.transfer.v1.MsgTransfer" }],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "sender",    value: VALDORA.address },
          { key: "recipient", value: NOBLE_BRIDGE },
          { key: "amount",    value: `499999000000${USDC_DENOM}` },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(1);
    expect(direction(alerts[0]!)).toBe("OUTFLOW");
  });

  it("two different events same recipient → one consolidated alert", async () => {
    await service.handleTransaction(makeTx({
      hash: "DUP3",
      messages: [],
      rawEvents: [
        { type: "transfer", attributes: [{ key: "sender", value: CONTRACT }, { key: "recipient", value: PMP_1.address }, { key: "amount", value: `100${USDC_DENOM}` }] },
        { type: "transfer", attributes: [{ key: "sender", value: CONTRACT }, { key: "recipient", value: PMP_1.address }, { key: "amount", value: `200${USDC_DENOM}` }] },
      ],
    }));
    expect(alerts).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe("edge cases", () => {
  it("completely empty tx — no alerts", async () => {
    await service.handleTransaction(makeTx());
    expect(alerts).toHaveLength(0);
  });

  it("untracked sender + untracked recipient — no alerts", async () => {
    await service.handleTransaction(makeTx({
      messages: [{ amounts: [{ amount: "1000", denom: ZIG_DENOM }], fromAddress: UNTRACKED, kind: "transfer", toAddress: UNTRACKED_2, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }],
      rawEvents: [{ type: "transfer", attributes: [{ key: "sender", value: UNTRACKED }, { key: "recipient", value: UNTRACKED_2 }, { key: "amount", value: "1000uzig" }] }],
    }));
    expect(alerts).toHaveLength(0);
  });

  it("non-transfer event type — no spurious alerts", async () => {
    await service.handleTransaction(makeTx({
      rawEvents: [
        { type: "coin_received", attributes: [{ key: "receiver", value: VAULT_1.address }, { key: "amount", value: "1000uzig" }] },
        { type: "message",       attributes: [{ key: "sender", value: VAULT_1.address }] },
      ],
    }));
    expect(alerts).toHaveLength(0);
  });

  it("5 wallets all receive in one block (concurrent)", async () => {
    await Promise.all([
      service.handleTransaction(makeTx({ hash: "C1", messages: [{ amounts: [{ amount: "1000000", denom: ZIG_DENOM }],    fromAddress: UNTRACKED, kind: "transfer", toAddress: VAULT_1.address,  typeUrl: "/cosmos.bank.v1beta1.MsgSend" }] })),
      service.handleTransaction(makeTx({ hash: "C2", messages: [{ amounts: [{ amount: "2000000", denom: ZIG_DENOM }],    fromAddress: UNTRACKED, kind: "transfer", toAddress: VAULT_2.address,  typeUrl: "/cosmos.bank.v1beta1.MsgSend" }] })),
      service.handleTransaction(makeTx({ hash: "C3", messages: [{ amounts: [{ amount: "440000000", denom: USDC_DENOM }],  fromAddress: UNTRACKED, kind: "transfer", toAddress: NAWA.address,     typeUrl: "/cosmos.bank.v1beta1.MsgSend" }] })),
      service.handleTransaction(makeTx({ hash: "C4", messages: [{ amounts: [{ amount: "500000", denom: ZIG_DENOM }],      fromAddress: UNTRACKED, kind: "transfer", toAddress: PMP_1.address,    typeUrl: "/cosmos.bank.v1beta1.MsgSend" }] })),
      service.handleTransaction(makeTx({ hash: "C5", messages: [{ amounts: [{ amount: "1000000000", denom: USDC_DENOM }], fromAddress: UNTRACKED, kind: "transfer", toAddress: VALDORA.address,  typeUrl: "/cosmos.bank.v1beta1.MsgSend" }] })),
    ]);
    expect(alerts).toHaveLength(5);
    const wallets = alerts.map((a) => a.wallet.address);
    expect(wallets).toContain(VAULT_1.address);
    expect(wallets).toContain(VAULT_2.address);
    expect(wallets).toContain(NAWA.address);
    expect(wallets).toContain(PMP_1.address);
    expect(wallets).toContain(VALDORA.address);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADVERSARIAL / REAL-WORLD EVENT SHAPES
// Things the chain actually emits that could silently break detection.
// ═══════════════════════════════════════════════════════════════════════════════

describe("adversarial event shapes", () => {

  // ── malformed / incomplete events ──────────────────────────────────────────

  it("AE-01  event missing amount field — still fires alert (amounts=[]) without crashing", async () => {
    await service.handleTransaction(makeTx({
      hash: "AE01",
      messages: [],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "sender",    value: UNTRACKED },
          { key: "recipient", value: VAULT_1.address },
          // no amount attribute
        ]},
      ],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VAULT_1.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("AE-02  event missing sender field — still fires INFLOW alert without crashing", async () => {
    await service.handleTransaction(makeTx({
      hash: "AE02",
      messages: [],
      rawEvents: [
        { type: "transfer", attributes: [
          // no sender attribute
          { key: "recipient", value: NAWA.address },
          { key: "amount",    value: `100000000${USDC_DENOM}` },
        ]},
      ],
    }));
    // sender is empty string — both tracked checks fail on sender side, but
    // recipient is tracked → should NOT fire because sender is empty (invalid event)
    expect(alerts).toHaveLength(0);
  });

  it("AE-03  event missing recipient field — no alert (can't determine direction)", async () => {
    await service.handleTransaction(makeTx({
      hash: "AE03",
      messages: [],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "sender", value: VAULT_1.address },
          // no recipient attribute
          { key: "amount", value: "1000000uzig" },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(0);
  });

  it("AE-04  event with extra unknown attributes — still detects correctly", async () => {
    await service.handleTransaction(makeTx({
      hash: "AE04",
      messages: [],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "module",     value: "bank" },
          { key: "sender",     value: UNTRACKED },
          { key: "recipient",  value: VALDORA.address },
          { key: "amount",     value: `500000000000${USDC_DENOM}` },
          { key: "memo",       value: "orbiter-cctp" },
          { key: "tx_hash",    value: "F6728E30C90A70007448A5" },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VALDORA.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  // ── multi-denom amounts ────────────────────────────────────────────────────

  it("AE-05  multi-denom amount string in event (ZIG + USDC in one transfer)", async () => {
    // Chain sometimes emits "1000uzig,500ibc/..." for multi-send
    await service.handleTransaction(makeTx({
      hash: "AE05",
      messages: [],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "sender",    value: UNTRACKED },
          { key: "recipient", value: VAULT_2.address },
          { key: "amount",    value: `5000000${ZIG_DENOM},100000000${USDC_DENOM}` },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VAULT_2.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  // ── noise events that must NOT trigger alerts ──────────────────────────────

  it("AE-06  coin_spent event for tracked wallet — no alert (not a transfer event)", async () => {
    await service.handleTransaction(makeTx({
      hash: "AE06",
      messages: [],
      rawEvents: [
        { type: "coin_spent",    attributes: [{ key: "spender", value: VAULT_1.address }, { key: "amount", value: "1000uzig" }] },
        { type: "coin_received", attributes: [{ key: "receiver", value: VAULT_1.address }, { key: "amount", value: "1000uzig" }] },
      ],
    }));
    expect(alerts).toHaveLength(0);
  });

  it("AE-07  message event with tracked wallet as sender — no alert (message event, not transfer)", async () => {
    await service.handleTransaction(makeTx({
      hash: "AE07",
      messages: [],
      rawEvents: [
        { type: "message", attributes: [{ key: "sender", value: NAWA.address }, { key: "action", value: "/cosmos.bank.v1beta1.MsgSend" }] },
      ],
    }));
    expect(alerts).toHaveLength(0);
  });

  it("AE-08  wasm event for tracked wallet — no alert (not a transfer event)", async () => {
    await service.handleTransaction(makeTx({
      hash: "AE08",
      messages: [],
      rawEvents: [
        { type: "wasm", attributes: [
          { key: "contract_address", value: CONTRACT },
          { key: "action",           value: "deposit" },
          { key: "_contract_address",value: CONTRACT },
          { key: "sender",           value: VAULT_1.address },
          { key: "amount",           value: "1000000" },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(0);
  });

  // ── multi-hop / routing scenarios ─────────────────────────────────────────

  it("AE-09  multi-hop IBC: 3 transfer events, tracked wallet is final recipient", async () => {
    // Noble → ZigChain route emits a fee transfer event, then the actual delivery.
    // Only the event where tracked wallet is recipient should alert.
    await service.handleTransaction(makeTx({
      hash: "AE09",
      messages: [],
      rawEvents: [
        // hop 1: relayer fee
        { type: "transfer", attributes: [{ key: "sender", value: UNTRACKED }, { key: "recipient", value: UNTRACKED_2 }, { key: "amount", value: "1000uzig" }] },
        // hop 2: intermediary routing
        { type: "transfer", attributes: [{ key: "sender", value: UNTRACKED_2 }, { key: "recipient", value: CONTRACT }, { key: "amount", value: `440000000${USDC_DENOM}` }] },
        // hop 3: actual delivery to tracked wallet
        { type: "transfer", attributes: [{ key: "sender", value: CONTRACT }, { key: "recipient", value: NAWA.address }, { key: "amount", value: `440000000${USDC_DENOM}` }] },
      ],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(NAWA.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("AE-10  multi-hop: tracked wallet is intermediate node — only fires for legs it's in", async () => {
    // VAULT_1 receives, then forwards to UNTRACKED in same tx.
    // Both legs appear as separate transfer events.
    await service.handleTransaction(makeTx({
      hash: "AE10",
      messages: [],
      rawEvents: [
        { type: "transfer", attributes: [{ key: "sender", value: UNTRACKED }, { key: "recipient", value: VAULT_1.address }, { key: "amount", value: `200000000${USDC_DENOM}` }] },
        { type: "transfer", attributes: [{ key: "sender", value: VAULT_1.address }, { key: "recipient", value: UNTRACKED_2 }, { key: "amount", value: `200000000${USDC_DENOM}` }] },
      ],
    }));
    // VAULT_1 appears as both recipient and sender → two alerts: INFLOW + OUTFLOW
    expect(alerts).toHaveLength(2);
    const dirs = alerts.map((a) => direction(a));
    expect(dirs).toContain("INFLOW");
    expect(dirs).toContain("OUTFLOW");
  });

  // ── staking / distribution style rewards ──────────────────────────────────

  it("AE-11  staking reward distribution → tracked wallet (event-only inflow)", async () => {
    const DISTRIBUTION_MODULE = "zig1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8ljv6u9";
    await service.handleTransaction(makeTx({
      hash: "AE11",
      messages: [],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "sender",    value: DISTRIBUTION_MODULE },
          { key: "recipient", value: PMP_2.address },
          { key: "amount",    value: "5000000uzig" },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(PMP_2.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  // ── authz / grant execution ────────────────────────────────────────────────

  it("AE-12  authz exec: grantee signs, tracked wallet is the real sender in events", async () => {
    // Authz: a different address signs the tx but the tracked wallet's funds move.
    // Message-level sender may be the grantee (untracked), but transfer event shows tracked wallet as sender.
    await service.handleTransaction(makeTx({
      hash: "AE12",
      messages: [
        // contract_call with grantee (untracked) as sender — won't alert
        { contract: CONTRACT, decodedMsg: { execute: {} }, funds: [], kind: "contract_call", rawPayload: '{"execute":{}}', sender: UNTRACKED, summary: "execute", typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract" },
      ],
      rawEvents: [
        // but the real movement is from tracked wallet
        { type: "transfer", attributes: [
          { key: "sender",    value: SMRWA.address },
          { key: "recipient", value: UNTRACKED },
          { key: "amount",    value: `1000000${ZIG_DENOM}` },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(SMRWA.address);
    expect(direction(alerts[0]!)).toBe("OUTFLOW");
  });

  // ── all 8 wallets receive in one giant tx ──────────────────────────────────

  it("AE-13  all 8 tracked wallets receive funds in a single tx — 8 inflow alerts", async () => {
    await service.handleTransaction(makeTx({
      hash: "AE13",
      messages: [],
      rawEvents: ALL_WALLETS.map((wallet, i) => ({
        type: "transfer",
        attributes: [
          { key: "sender",    value: UNTRACKED },
          { key: "recipient", value: wallet.address },
          { key: "amount",    value: `${(i + 1) * 1000000}${USDC_DENOM}` },
        ],
      })),
    }));
    expect(alerts).toHaveLength(8);
    const walletAddrs = alerts.map((a) => a.wallet.address);
    for (const w of ALL_WALLETS) {
      expect(walletAddrs).toContain(w.address);
    }
    alerts.forEach((a) => expect(direction(a)).toBe("INFLOW"));
  });

  it("AE-14  all 8 tracked wallets send funds in a single tx — 8 outflow alerts", async () => {
    await service.handleTransaction(makeTx({
      hash: "AE14",
      messages: [],
      rawEvents: ALL_WALLETS.map((wallet, i) => ({
        type: "transfer",
        attributes: [
          { key: "sender",    value: wallet.address },
          { key: "recipient", value: UNTRACKED },
          { key: "amount",    value: `${(i + 1) * 1000000}${USDC_DENOM}` },
        ],
      })),
    }));
    expect(alerts).toHaveLength(8);
    alerts.forEach((a) => expect(direction(a)).toBe("OUTFLOW"));
  });

  // ── mixed noise + real signal ──────────────────────────────────────────────

  it("AE-15  20 irrelevant events followed by 1 real inflow — catches the real one", async () => {
    const noiseEvents = Array.from({ length: 20 }, (_, i) => ({
      type: i % 3 === 0 ? "coin_received" : i % 3 === 1 ? "wasm" : "message",
      attributes: [
        { key: "sender",    value: UNTRACKED },
        { key: "recipient", value: UNTRACKED_2 },
        { key: "amount",    value: "9999uzig" },
      ],
    }));
    await service.handleTransaction(makeTx({
      hash: "AE15",
      messages: [],
      rawEvents: [
        ...noiseEvents,
        { type: "transfer", attributes: [
          { key: "sender",    value: UNTRACKED },
          { key: "recipient", value: NAWA_ADMIN.address },
          { key: "amount",    value: `200000000${USDC_DENOM}` },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(NAWA_ADMIN.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });

  it("AE-16  orbiter CCTP bridge-out: real tx memo structure, tracked wallet sends", async () => {
    // Mirrors the exact real transactions that were missing before the IBC fix
    await service.handleTransaction(makeTx({
      hash: "F6728E30C90A70007448A513DD668E882E2B4A10A4A8CA0F414033D1CBCBD881",
      memo: '{"orbiter":{"forwarding":{"protocol_id":"PROTOCOL_CCTP"}}}',
      messages: [{
        amounts: [{ amount: "499999000000", denom: USDC_DENOM }],
        fromAddress: VALDORA.address,
        kind: "transfer",
        toAddress: NOBLE_BRIDGE,
        typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
      }],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VALDORA.address);
    expect(direction(alerts[0]!)).toBe("OUTFLOW");
  });

  it("AE-17  orbiter CCTP bridge-in: contract delivers USDC to tracked wallet via event", async () => {
    await service.handleTransaction(makeTx({
      hash: "AA84219726E67BEB9C15286886A43FC18FCEA82818A7F5A7D0171A5169BB3366",
      messages: [{ contract: CONTRACT, decodedMsg: { deposit: {} }, funds: [{ amount: "1299999000000", denom: USDC_DENOM }], kind: "contract_call", rawPayload: '{"deposit":{}}', sender: UNTRACKED, summary: "deposit", typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract" }],
      rawEvents: [
        { type: "transfer", attributes: [
          { key: "sender",    value: CONTRACT },
          { key: "recipient", value: VAULT_2.address },
          { key: "amount",    value: `1299999000000${USDC_DENOM}` },
        ]},
      ],
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.wallet.address).toBe(VAULT_2.address);
    expect(direction(alerts[0]!)).toBe("INFLOW");
  });
});
