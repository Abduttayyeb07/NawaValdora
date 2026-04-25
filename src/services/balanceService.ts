import type { Logger } from "pino";

const ZIG_DENOM = "uzig";
const USDC_DENOM = "ibc/6490A7EAB61059BFC1CDDEB05917DD70BDF3A611654162A1A47DB930D40D8AF4";
const EXPONENT = 1_000_000;

interface LcdBalancesResponse {
  readonly balances: ReadonlyArray<{ readonly amount: string; readonly denom: string }>;
}

export interface WalletBalance {
  readonly address: string;
  readonly usdc: number;
  readonly zig: number;
}

export class BalanceService {
  private readonly lcdUrl: string;

  private readonly logger: Logger;

  public constructor(options: { readonly lcdUrl: string; readonly logger: Logger }) {
    this.lcdUrl = options.lcdUrl.replace(/\/$/, "");
    this.logger = options.logger.child({ component: "balance-service" });
  }

  public async fetchBalance(address: string): Promise<WalletBalance> {
    const url = `${this.lcdUrl}/cosmos/bank/v1beta1/balances/${address}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });

    if (!response.ok) {
      throw new Error(`LCD request failed with status ${response.status} for ${address}`);
    }

    const data = (await response.json()) as LcdBalancesResponse;

    let zig = 0;
    let usdc = 0;

    for (const coin of data.balances) {
      if (coin.denom === ZIG_DENOM) {
        zig = Number(coin.amount) / EXPONENT;
      } else if (coin.denom === USDC_DENOM) {
        usdc = Number(coin.amount) / EXPONENT;
      }
    }

    this.logger.debug({ address, usdc, zig }, "Fetched wallet balance");
    return { address, usdc, zig };
  }
}
