import { resolve } from "node:path";

import type { TrackedWallet } from "../types/blockchain";

export interface AppConfig {
  readonly pollIntervalMs: number;
  readonly reconnectBaseDelayMs: number;
  readonly reconnectMaxDelayMs: number;
  readonly rpcRequestTimeoutMs: number;
  readonly rpcUrl: string;
  readonly stateFilePath: string;
  readonly trackedWallets: TrackedWallet[];
  readonly wsHeartbeatMs: number;
  readonly wsStaleMs: number;
  readonly wsUrl: string;
  readonly telegramBotToken: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseWalletList(raw: string): string[] {
  const wallets = raw
    .split(/[,\n]+/)
    .map((wallet) => wallet.trim())
    .filter(Boolean);

  if (wallets.length === 0) {
    throw new Error("VAULT_WALLETS must contain at least one wallet address");
  }

  return wallets;
}

function ensureUrl(url: string, name: string): string {
  try {
    return new URL(url).toString();
  } catch (error) {
    throw new Error(`${name} must be a valid URL`, { cause: error });
  }
}

function buildTrackedWallets(vaultWallets: string[], nawaWallet: string): TrackedWallet[] {
  const seen = new Set<string>();
  const wallets: TrackedWallet[] = [];

  vaultWallets.forEach((address, index) => {
    if (seen.has(address)) {
      return;
    }
    seen.add(address);
    wallets.push({
      address,
      kind: "vault",
      label: `VAULT_${index + 1}`,
    });
  });

  if (!seen.has(nawaWallet)) {
    wallets.push({
      address: nawaWallet,
      kind: "nawa_usdc",
      label: "NAWA_USDC_WALLET",
    });
  }

  return wallets;
}

export function loadConfig(): AppConfig {
  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const rpcUrl = ensureUrl(requireEnv("RPC_URL"), "RPC_URL");
  const wsUrl = ensureUrl(requireEnv("WS_URL"), "WS_URL");
  const vaultWallets = parseWalletList(requireEnv("VAULT_WALLETS"));
  const nawaUsdcWallet = requireEnv("NAWA_USDC_WALLET");

  return {
    pollIntervalMs: 5_000,
    reconnectBaseDelayMs: 1_000,
    reconnectMaxDelayMs: 30_000,
    rpcRequestTimeoutMs: 15_000,
    rpcUrl,
    stateFilePath: resolve(process.cwd(), "data", "state.json"),
    trackedWallets: buildTrackedWallets(vaultWallets, nawaUsdcWallet),
    wsHeartbeatMs: 20_000,
    wsStaleMs: 45_000,
    wsUrl,
    telegramBotToken,
  };
}
