import type { Logger } from "pino";

import type { RpcClient } from "./rpcClient";

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class PollingFallback {
  private readonly intervalMs: number;

  private readonly logger: Logger;

  private readonly onHeight: (height: number) => void;

  private readonly rpcClient: RpcClient;

  private running = false;

  private stopped = false;

  public constructor(options: {
    readonly intervalMs: number;
    readonly logger: Logger;
    readonly onHeight: (height: number) => void;
    readonly rpcClient: RpcClient;
  }) {
    this.intervalMs = options.intervalMs;
    this.logger = options.logger.child({ component: "polling-fallback" });
    this.onHeight = options.onHeight;
    this.rpcClient = options.rpcClient;
  }

  public start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.stopped = false;
    this.logger.info({ intervalMs: this.intervalMs }, "Polling fallback started");
    void this.loop();
  }

  public stop(): void {
    this.stopped = true;
    this.logger.info("Polling fallback stopped");
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const latestHeight = await this.rpcClient.getLatestHeight();
        this.onHeight(latestHeight);
      } catch (error) {
        this.logger.error({ error }, "Polling fallback failed");
      }

      await sleep(this.intervalMs);
    }

    this.running = false;
  }
}
