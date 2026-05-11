import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationService } from "../services/notificationService";
import { TransactionMonitorService } from "../services/transactionMonitorService";
import type { ParsedTransaction, TrackedWallet, WalletAlert } from "../types/blockchain";

// ── helpers ──────────────────────────────────────────────────────────────────

const mockLogger = {
  child: () => mockLogger,
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
} as never;

const VAULT_1: TrackedWallet = { address: "zig1vault1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "vault", label: "Vault 1" };
const VAULT_2: TrackedWallet = { address: "zig1vault2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "vault", label: "Vault 2" };
const NAWA: TrackedWallet = { address: "zig1nawaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "nawa_usdc", label: "NAWA" };
const UNTRACKED = "zig1untrackedaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTRACT = "zig1contractaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USDC_DENOM = "ibc/6490A7EAB61059BFC1CDDEB05917DD70BDF3A611654162A1A47DB930D40D8AF4";

function makeTx(overrides: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return {
    code: 0,
    fee: [],
    hash: "DEADBEEF",
    height: 1000,
    messages: [],
    rawEvents: [],
    ...overrides,
  };
}

// ── setup ─────────────────────────────────────────────────────────────────────

let alerts: WalletAlert[];
let service: TransactionMonitorService;

beforeEach(() => {
  alerts = [];
  const mockNotification = {
    sendAlert: vi.fn(async (alert: WalletAlert) => {
      alerts.push(alert);
    }),
  } as unknown as NotificationService;

  service = new TransactionMonitorService({
    logger: mockLogger,
    notificationService: mockNotification,
    trackedWallets: [VAULT_1, VAULT_2, NAWA],
  });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("failed / empty transactions", () => {
  it("skips failed tx (code != 0) — no alert", async () => {
    await service.handleTransaction(
      makeTx({
        code: 1,
        messages: [
          {
            amounts: [{ amount: "1000000", denom: "uzig" }],
            fromAddress: UNTRACKED,
            kind: "transfer",
            toAddress: VAULT_1.address,
            typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          },
        ],
      }),
    );
    expect(alerts).toHaveLength(0);
  });

  it("fires no alert for a tx with no tracked wallets anywhere", async () => {
    await service.handleTransaction(
      makeTx({
        messages: [
          {
            amounts: [{ amount: "1000", denom: "uzig" }],
            fromAddress: UNTRACKED,
            kind: "transfer",
            toAddress: "zig1someoneelse000000000000000000000000",
            typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          },
        ],
      }),
    );
    expect(alerts).toHaveLength(0);
  });

  it("fires no alert for an empty tx (no messages, no events)", async () => {
    await service.handleTransaction(makeTx());
    expect(alerts).toHaveLength(0);
  });
});

describe("transfer alerts", () => {
  it("fires OUTFLOW when tracked wallet sends funds", async () => {
    await service.handleTransaction(
      makeTx({
        messages: [
          {
            amounts: [{ amount: "5000000", denom: "uzig" }],
            fromAddress: VAULT_1.address,
            kind: "transfer",
            toAddress: UNTRACKED,
            typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          },
        ],
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("transfer");
    expect(alerts[0]?.direction).toBe("OUTFLOW");
    expect(alerts[0]?.wallet.address).toBe(VAULT_1.address);
  });

  it("fires INFLOW when tracked wallet receives funds (MsgSend)", async () => {
    await service.handleTransaction(
      makeTx({
        messages: [
          {
            amounts: [{ amount: "10000000", denom: "uzig" }],
            fromAddress: UNTRACKED,
            kind: "transfer",
            toAddress: NAWA.address,
            typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          },
        ],
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.direction).toBe("INFLOW");
    expect(alerts[0]?.wallet.address).toBe(NAWA.address);
  });

  it("fires OUTFLOW + INFLOW for tracked-to-tracked transfer", async () => {
    await service.handleTransaction(
      makeTx({
        messages: [
          {
            amounts: [{ amount: "1000000", denom: "uzig" }],
            fromAddress: VAULT_1.address,
            kind: "transfer",
            toAddress: VAULT_2.address,
            typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          },
        ],
      }),
    );
    expect(alerts).toHaveLength(2);
    const directions = alerts.map((a) => a.direction);
    expect(directions).toContain("OUTFLOW");
    expect(directions).toContain("INFLOW");
  });
});

describe("swap alerts", () => {
  it("fires swap alert when tracked wallet executes a swap", async () => {
    await service.handleTransaction(
      makeTx({
        messages: [
          {
            contract: CONTRACT,
            decodedMsg: { swap: {} },
            funds: [{ amount: "1000000", denom: "uzig" }],
            kind: "swap",
            rawPayload: '{"swap":{}}',
            sender: VAULT_1.address,
            swapAction: "swap",
            typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          },
        ],
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("swap");
    expect(alerts[0]?.wallet.address).toBe(VAULT_1.address);
  });

  it("fires no swap alert when swap sender is untracked", async () => {
    await service.handleTransaction(
      makeTx({
        messages: [
          {
            contract: CONTRACT,
            decodedMsg: { swap: {} },
            funds: [{ amount: "1000000", denom: "uzig" }],
            kind: "swap",
            rawPayload: '{"swap":{}}',
            sender: UNTRACKED,
            swapAction: "swap",
            typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          },
        ],
      }),
    );
    expect(alerts).toHaveLength(0);
  });
});

describe("event-based inflow (contract deposit)", () => {
  it("fires INFLOW when NAWA appears only as transfer.recipient in events", async () => {
    await service.handleTransaction(
      makeTx({
        messages: [
          {
            contract: CONTRACT,
            decodedMsg: { deposit: {} },
            funds: [{ amount: "440000000", denom: USDC_DENOM }],
            kind: "contract_call",
            rawPayload: '{"deposit":{}}',
            sender: UNTRACKED,
            summary: "deposit",
            typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          },
        ],
        rawEvents: [
          {
            attributes: [
              { key: "sender", value: CONTRACT },
              { key: "recipient", value: NAWA.address },
              { key: "amount", value: `440000000${USDC_DENOM}` },
            ],
            type: "transfer",
          },
        ],
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("transfer");
    expect(alerts[0]?.direction).toBe("INFLOW");
    expect(alerts[0]?.wallet.address).toBe(NAWA.address);
  });

  it("does not double-alert when wallet appears in both message and events", async () => {
    await service.handleTransaction(
      makeTx({
        messages: [
          {
            amounts: [{ amount: "1000000", denom: "uzig" }],
            fromAddress: UNTRACKED,
            kind: "transfer",
            toAddress: VAULT_1.address,
            typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          },
        ],
        rawEvents: [
          {
            attributes: [
              { key: "sender", value: UNTRACKED },
              { key: "recipient", value: VAULT_1.address },
              { key: "amount", value: "1000000uzig" },
            ],
            type: "transfer",
          },
        ],
      }),
    );
    expect(alerts).toHaveLength(1);
  });

  it("fires no event inflow alert when transfer.recipient is untracked", async () => {
    await service.handleTransaction(
      makeTx({
        rawEvents: [
          {
            attributes: [
              { key: "sender", value: CONTRACT },
              { key: "recipient", value: UNTRACKED },
              { key: "amount", value: "1000000uzig" },
            ],
            type: "transfer",
          },
        ],
      }),
    );
    expect(alerts).toHaveLength(0);
  });
});

describe("concurrent transactions", () => {
  it("fires all 3 alerts when 3 tracked txs are processed at once", async () => {
    const tx1 = makeTx({
      hash: "TX1",
      messages: [
        {
          amounts: [{ amount: "1000000", denom: "uzig" }],
          fromAddress: UNTRACKED,
          kind: "transfer",
          toAddress: VAULT_1.address,
          typeUrl: "/cosmos.bank.v1beta1.MsgSend",
        },
      ],
    });
    const tx2 = makeTx({
      hash: "TX2",
      messages: [
        {
          amounts: [{ amount: "2000000", denom: "uzig" }],
          fromAddress: UNTRACKED,
          kind: "transfer",
          toAddress: VAULT_2.address,
          typeUrl: "/cosmos.bank.v1beta1.MsgSend",
        },
      ],
    });
    const tx3 = makeTx({
      hash: "TX3",
      messages: [
        {
          contract: CONTRACT,
          decodedMsg: { deposit: {} },
          funds: [],
          kind: "contract_call",
          rawPayload: '{"deposit":{}}',
          sender: UNTRACKED,
          summary: "deposit",
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        },
      ],
      rawEvents: [
        {
          attributes: [
            { key: "sender", value: CONTRACT },
            { key: "recipient", value: NAWA.address },
            { key: "amount", value: `440000000${USDC_DENOM}` },
          ],
          type: "transfer",
        },
      ],
    });

    await Promise.all([
      service.handleTransaction(tx1),
      service.handleTransaction(tx2),
      service.handleTransaction(tx3),
    ]);

    expect(alerts).toHaveLength(3);
    const wallets = alerts.map((a) => a.wallet.address);
    expect(wallets).toContain(VAULT_1.address);
    expect(wallets).toContain(VAULT_2.address);
    expect(wallets).toContain(NAWA.address);
  });

  it("fires all alerts when one tx has multiple tracked wallets involved", async () => {
    await service.handleTransaction(
      makeTx({
        hash: "MULTI",
        messages: [
          {
            amounts: [{ amount: "1000000", denom: "uzig" }],
            fromAddress: VAULT_1.address,
            kind: "transfer",
            toAddress: VAULT_2.address,
            typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          },
        ],
        rawEvents: [
          {
            attributes: [
              { key: "sender", value: CONTRACT },
              { key: "recipient", value: NAWA.address },
              { key: "amount", value: `50000000${USDC_DENOM}` },
            ],
            type: "transfer",
          },
        ],
      }),
    );
    // VAULT_1 OUTFLOW + VAULT_2 INFLOW + NAWA event inflow
    expect(alerts).toHaveLength(3);
  });
});

describe("contract call alerts", () => {
  it("fires contract_call alert when tracked wallet is the sender", async () => {
    await service.handleTransaction(
      makeTx({
        messages: [
          {
            contract: CONTRACT,
            decodedMsg: { withdraw: {} },
            funds: [],
            kind: "contract_call",
            rawPayload: '{"withdraw":{}}',
            sender: VAULT_1.address,
            summary: "withdraw",
            typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          },
        ],
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("contract_call");
    expect(alerts[0]?.wallet.address).toBe(VAULT_1.address);
  });
});
