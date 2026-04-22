import type { Logger } from "pino";

import type { IndexedEvent, RpcTxResult } from "../types/blockchain";

interface RpcEnvelope<T> {
  readonly error?: {
    readonly code?: number;
    readonly data?: unknown;
    readonly message?: string;
  };
  readonly result?: T;
}

interface StatusResult {
  readonly sync_info?: {
    readonly latest_block_height?: string;
  };
  readonly syncInfo?: {
    readonly latestBlockHeight?: string;
  };
}

interface BlockResult {
  readonly block?: {
    readonly data?: {
      readonly txs?: string[];
    };
    readonly header?: {
      readonly height?: string;
      readonly time?: string;
    };
  };
}

interface BlockResultsResult {
  readonly txs_results?: RawTxResult[];
  readonly txsResults?: RawTxResult[];
}

interface RawTxResult {
  readonly code?: number | string;
  readonly events?: RawEvent[];
  readonly gas_used?: string;
  readonly gas_wanted?: string;
  readonly log?: string;
}

interface RawEvent {
  readonly attributes?: RawAttribute[];
  readonly type?: string;
}

interface RawAttribute {
  readonly key?: string;
  readonly value?: string;
}

export interface RpcBlock {
  readonly height: number;
  readonly timestamp?: string;
  readonly txs: string[];
}

function toNumber(value: string | number | undefined, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function normalizeEvents(events: RawEvent[] | undefined): IndexedEvent[] {
  return (events ?? []).map((event) => ({
    attributes: (event.attributes ?? []).map((attribute) => ({
      key: attribute.key ?? "",
      value: attribute.value ?? "",
    })),
    type: event.type ?? "",
  }));
}

function normalizeTxResult(result: RawTxResult | undefined): RpcTxResult {
  return {
    code: toNumber(result?.code, 0),
    events: normalizeEvents(result?.events),
    ...(result?.gas_used ? { gasUsed: result.gas_used } : {}),
    ...(result?.gas_wanted ? { gasWanted: result.gas_wanted } : {}),
    ...(result?.log ? { log: result.log } : {}),
  };
}

export class RpcClient {
  private readonly baseUrl: string;

  private readonly logger: Logger;

  private readonly timeoutMs: number;

  public constructor(options: {
    readonly logger: Logger;
    readonly rpcUrl: string;
    readonly timeoutMs: number;
  }) {
    this.baseUrl = options.rpcUrl.endsWith("/") ? options.rpcUrl : `${options.rpcUrl}/`;
    this.logger = options.logger.child({ component: "rpc-client" });
    this.timeoutMs = options.timeoutMs;
  }

  public async getLatestHeight(): Promise<number> {
    const response = await this.request<StatusResult>("status");
    const height =
      response.sync_info?.latest_block_height ?? response.syncInfo?.latestBlockHeight;

    if (!height) {
      throw new Error("RPC status response did not include latest block height");
    }

    return toNumber(height);
  }

  public async getBlock(height: number): Promise<RpcBlock> {
    const response = await this.request<BlockResult>("block", { height: String(height) });
    const blockHeight = response.block?.header?.height;

    return {
      height: toNumber(blockHeight, height),
      ...(response.block?.header?.time ? { timestamp: response.block.header.time } : {}),
      txs: response.block?.data?.txs ?? [],
    };
  }

  public async getBlockResults(height: number): Promise<RpcTxResult[]> {
    const response = await this.request<BlockResultsResult>("block_results", {
      height: String(height),
    });

    const txResults = response.txs_results ?? response.txsResults ?? [];
    return txResults.map((result) => normalizeTxResult(result));
  }

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
        },
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`RPC request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as RpcEnvelope<T>;
      if (payload.error) {
        throw new Error(payload.error.message ?? "RPC request failed");
      }

      if (!payload.result) {
        throw new Error(`RPC ${path} response did not include a result`);
      }

      return payload.result;
    } catch (error) {
      this.logger.error({ error, path, params }, "RPC request failed");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
