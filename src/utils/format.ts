import type {
  AlertDirection,
  EventAttribute,
  IndexedEvent,
  NormalizedCoin,
  TokenDescriptor,
  TrackedWallet,
} from "../types/blockchain";

export function shortAddress(address: string, head = 10, tail = 6): string {
  if (address.length <= head + tail + 3) {
    return address;
  }
  return `${address.slice(0, head)}...${address.slice(-tail)}`;
}

export function formatWallet(wallet: TrackedWallet): string {
  return `${wallet.label} (${shortAddress(wallet.address)})`;
}

export function formatDirection(direction: AlertDirection): string {
  return direction;
}

const IBC_DENOMS: Record<string, { decimals: number; symbol: string }> = {
  "ibc/6490A7EAB61059BFC1CDDEB05917DD70BDF3A611654162A1A47DB930D40D8AF4": { decimals: 6, symbol: "USDC" },
};

function getDisplayDenom(denom: string): { decimals: number; symbol: string } | null {
  if (denom in IBC_DENOMS) {
    return IBC_DENOMS[denom] ?? null;
  }

  if (/^u[a-z][a-z0-9]+$/i.test(denom)) {
    return {
      decimals: 6,
      symbol: denom.slice(1).toUpperCase(),
    };
  }

  return null;
}

function formatIntegerAmount(amount: string, decimals: number): string {
  const normalized = amount.replace(/^0+(?=\d)/, "");
  const value = normalized === "" ? "0" : normalized;

  if (decimals === 0) {
    return value;
  }

  const padded = value.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");

  const wholeWithCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${wholeWithCommas}.${fraction}` : wholeWithCommas;
}

export function formatCoin(coin: NormalizedCoin): string {
  const display = getDisplayDenom(coin.denom);
  if (!display) {
    return `${coin.amount} ${coin.denom}`;
  }

  return `${formatIntegerAmount(coin.amount, display.decimals)} ${display.symbol}`;
}

export function formatCoinList(coins: readonly NormalizedCoin[]): string {
  if (coins.length === 0) {
    return "N/A";
  }

  return coins.map((coin) => formatCoin(coin)).join(", ");
}

export function formatTokenDescriptor(token?: TokenDescriptor): string {
  if (!token) {
    return "Unknown";
  }

  if (token.amount && token.denom) {
    return formatCoin({
      amount: token.amount,
      denom: token.denom,
    });
  }

  if (token.denom) {
    return token.displayName || token.denom;
  }

  return token.displayName;
}

export function tryDecodeBase64String(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0 || !/^[A-Za-z0-9+/=]+$/.test(trimmed)) {
    return value;
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    const printableChars = decoded
      .split("")
      .filter((char) => {
        const code = char.charCodeAt(0);
        return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);
      })
      .length;

    if (decoded.length === 0 || printableChars / decoded.length < 0.9) {
      return value;
    }

    return decoded;
  } catch {
    return value;
  }
}

export function normalizeEventAttributes(attributes: readonly EventAttribute[]): EventAttribute[] {
  return attributes.map((attribute) => ({
    key: tryDecodeBase64String(attribute.key),
    value: tryDecodeBase64String(attribute.value),
  }));
}

export function normalizeEvents(events: readonly IndexedEvent[]): IndexedEvent[] {
  return events.map((event) => ({
    attributes: normalizeEventAttributes(event.attributes),
    type: tryDecodeBase64String(event.type),
  }));
}

export function parseCoinString(value: string): NormalizedCoin | null {
  const match = value.trim().match(/^(\d+)(.+)$/);
  if (!match) {
    return null;
  }

  const amount = match[1];
  const denom = match[2];
  if (!amount || !denom) {
    return null;
  }

  return {
    amount,
    denom,
  };
}

export function parseCoinsString(value: string): NormalizedCoin[] {
  return value
    .split(",")
    .map((entry) => parseCoinString(entry))
    .filter((coin): coin is NormalizedCoin => coin !== null);
}
