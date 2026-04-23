import WebSocket from "ws";
import type { Logger } from "pino";
import type { TrackedWallet } from "../types/blockchain";
import { buildWalletScopedSubscriptions, type WalletScopedQuery } from "./walletQueries";

function toHeight(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function extractHeight(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const result = record.result as Record<string, unknown> | undefined;
  const events = result?.events as Record<string, unknown> | undefined;

  const txHeight = events?.["tx.height"];
  if (Array.isArray(txHeight) && txHeight.length > 0) {
    return toHeight(txHeight[0]);
  }

  const data = result?.data as Record<string, unknown> | undefined;
  const value = data?.value as Record<string, unknown> | undefined;
  const txResult = value?.TxResult as Record<string, unknown> | undefined;
  const txResultHeight = txResult?.height;
  const parsedTxResultHeight = toHeight(txResultHeight);
  if (parsedTxResultHeight !== null) {
    return parsedTxResultHeight;
  }

  const block = value?.block as Record<string, unknown> | undefined;
  const header = block?.header as Record<string, unknown> | undefined;
  return toHeight(header?.height);
}

function extractQuery(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const result = record.result as Record<string, unknown> | undefined;
  return typeof result?.query === "string" ? result.query : null;
}

export class WebsocketListener {
  private readonly heartbeatMs: number;

  private lastMessageAt = 0;

  private readonly logger: Logger;

  private readonly onHeight: (height: number) => void;

  private readonly reconnectBaseDelayMs: number;

  private reconnectTimer: NodeJS.Timeout | undefined;

  private readonly reconnectMaxDelayMs: number;

  private reconnectAttempts = 0;

  private stopped = false;

  private readonly staleMs: number;

  private readonly subscriptions: readonly WalletScopedQuery[];

  private websocket: WebSocket | undefined;

  private heartbeatTimer: NodeJS.Timeout | undefined;

  private readonly wsUrl: string;

  public constructor(options: {
    readonly heartbeatMs: number;
    readonly logger: Logger;
    readonly onHeight: (height: number) => void;
    readonly reconnectBaseDelayMs: number;
    readonly reconnectMaxDelayMs: number;
    readonly staleMs: number;
    readonly trackedWallets: readonly TrackedWallet[];
    readonly wsUrl: string;
  }) {
    this.heartbeatMs = options.heartbeatMs;
    this.logger = options.logger.child({ component: "ws-listener" });
    this.onHeight = options.onHeight;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs;
    this.staleMs = options.staleMs;
    this.subscriptions = buildWalletScopedSubscriptions(options.trackedWallets);
    this.wsUrl = options.wsUrl;
  }

  public start(): void {
    this.stopped = false;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.websocket?.removeAllListeners();
    this.websocket?.terminate();
    this.websocket = undefined;
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }

    this.logger.info({ wsUrl: this.wsUrl }, "Connecting to ZigChain WebSocket");
    const websocket = new WebSocket(this.wsUrl);
    this.websocket = websocket;

    websocket.on("open", () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      for (const subscription of this.subscriptions) {
        this.subscribe(subscription);
      }
      this.startHeartbeat();
      this.logger.info(
        { subscriptionCount: this.subscriptions.length },
        "WebSocket connection established for wallet-scoped subscriptions",
      );
    });

    websocket.on("message", (data) => {
      this.lastMessageAt = Date.now();
      const raw = typeof data === "string" ? data : data.toString("utf8");

      try {
        const payload = JSON.parse(raw) as unknown;
        const query = extractQuery(payload);
        const height = extractHeight(payload);
        if (height !== null) {
          this.logger.debug({ height, query }, "WebSocket event received");
          this.onHeight(height);
        }
      } catch (error) {
        this.logger.warn({ error, raw }, "Failed to parse WebSocket message");
      }
    });

    websocket.on("pong", () => {
      this.lastMessageAt = Date.now();
    });

    websocket.on("error", (error) => {
      this.logger.error({ error }, "WebSocket listener error");
    });

    websocket.on("close", (code, reason) => {
      const closeReason = typeof reason === "string" ? reason : reason.toString("utf8");
      this.logger.warn({ code, reason: closeReason }, "WebSocket connection closed");
      this.cleanupSocket();
      this.scheduleReconnect();
    });
  }

  private cleanupSocket(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    if (this.websocket) {
      this.websocket.removeAllListeners();
      this.websocket = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    this.reconnectAttempts += 1;
    const delayMs = Math.min(
      this.reconnectBaseDelayMs * 2 ** (this.reconnectAttempts - 1),
      this.reconnectMaxDelayMs,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);

    this.logger.warn({ attempt: this.reconnectAttempts, delayMs }, "Scheduling WebSocket reconnect");
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      const websocket = this.websocket;
      if (!websocket || websocket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (Date.now() - this.lastMessageAt > this.staleMs) {
        this.logger.warn("WebSocket stream is stale, forcing reconnect");
        websocket.terminate();
        return;
      }

      websocket.ping();
    }, this.heartbeatMs);
  }

  private subscribe(subscription: WalletScopedQuery): void {
    const websocket = this.websocket;
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.logger.info(
      {
        eventKey: subscription.eventKey,
        id: subscription.id,
        query: subscription.query,
        walletAddress: subscription.walletAddress,
      },
      "Subscribing to wallet-scoped WebSocket query",
    );
    websocket.send(
      JSON.stringify({
        id: subscription.id,
        jsonrpc: "2.0",
        method: "subscribe",
        params: {
          query: subscription.query,
        },
      }),
    );
  }
}
