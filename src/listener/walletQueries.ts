import type { TrackedWallet } from "../types/blockchain";

export interface WalletScopedQuery {
  readonly eventKey: "message.sender" | "transfer.recipient" | "transfer.sender";
  readonly id: string;
  readonly query: string;
  readonly walletAddress: string;
}

function uniqueWalletAddresses(trackedWallets: readonly TrackedWallet[]): string[] {
  return [...new Set(trackedWallets.map((wallet) => wallet.address))];
}

export function buildWalletScopedSubscriptions(
  trackedWallets: readonly TrackedWallet[],
): WalletScopedQuery[] {
  return uniqueWalletAddresses(trackedWallets).flatMap((walletAddress, index) => [
    {
      eventKey: "message.sender",
      id: `wallet-${index + 1}-message-sender`,
      query: `tm.event='Tx' AND message.sender='${walletAddress}'`,
      walletAddress,
    },
    {
      eventKey: "transfer.sender",
      id: `wallet-${index + 1}-transfer-sender`,
      query: `tm.event='Tx' AND transfer.sender='${walletAddress}'`,
      walletAddress,
    },
    {
      eventKey: "transfer.recipient",
      id: `wallet-${index + 1}-transfer-recipient`,
      query: `tm.event='Tx' AND transfer.recipient='${walletAddress}'`,
      walletAddress,
    },
  ]);
}

export function buildWalletTxSearchQueries(
  trackedWallets: readonly TrackedWallet[],
): WalletScopedQuery[] {
  return uniqueWalletAddresses(trackedWallets).flatMap((walletAddress, index) => [
    {
      eventKey: "message.sender",
      id: `wallet-${index + 1}-message-sender`,
      query: `message.sender='${walletAddress}'`,
      walletAddress,
    },
    {
      eventKey: "transfer.sender",
      id: `wallet-${index + 1}-transfer-sender`,
      query: `transfer.sender='${walletAddress}'`,
      walletAddress,
    },
    {
      eventKey: "transfer.recipient",
      id: `wallet-${index + 1}-transfer-recipient`,
      query: `transfer.recipient='${walletAddress}'`,
      walletAddress,
    },
  ]);
}
