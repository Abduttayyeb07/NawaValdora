import type { Logger } from "pino";

const ZIG_DENOM = "azig";
const USDC_DENOM = "ibc/6490A7EAB61059BFC1CDDEB05917DD70BDF3A611654162A1A47DB930D40D8AF4";

// ZigChain went EVM-compatible: native denom is now azig (18 decimals, atto-unit),
// up from uzig (6 decimals). USDC's IBC denom is unaffected — still 6 decimals.
const ZIG_EXPONENT = 10n ** 18n;
const USDC_EXPONENT = 1_000_000;

// Raw amounts at 18 decimals blow past Number.MAX_SAFE_INTEGER (~9.007e15) for any
// real balance, so Number(rawAmount) silently corrupts the value. Do the scaling in
// BigInt first, then convert only the final human-scale value (safely small) to Number.
function rawZigToNumber(rawAmount: string): number {
  const raw = BigInt(rawAmount);
  const whole = raw / ZIG_EXPONENT;
  const remainder = raw % ZIG_EXPONENT;
  const fraction = remainder.toString().padStart(18, "0").replace(/0+$/, "") || "0";
  return Number(`${whole}.${fraction}`);
}

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
        zig = rawZigToNumber(coin.amount);
      } else if (coin.denom === USDC_DENOM) {
        usdc = Number(coin.amount) / USDC_EXPONENT;
      }
    }

    this.logger.debug({ address, usdc, zig }, "Fetched wallet balance");
    return { address, usdc, zig };
  }
}
