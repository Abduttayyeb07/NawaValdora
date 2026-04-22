import type { Logger } from "pino";

import type { TransactionParser } from "../parser/txParser";
import { retryWithBackoff } from "../utils/retry";
import type { RpcClient } from "./rpcClient";
import type { StateStore } from "../services/stateStore";
import type { TransactionMonitorService } from "../services/transactionMonitorService";

export class BlockProcessor {
  private currentHeight = 0;

  private readonly logger: Logger;

  private running = false;

  private readonly rpcClient: RpcClient;

  private readonly stateStore: StateStore;

  private targetHeight = 0;

  private readonly transactionMonitorService: TransactionMonitorService;

  private readonly transactionParser: TransactionParser;

  public constructor(options: {
    readonly logger: Logger;
    readonly rpcClient: RpcClient;
    readonly stateStore: StateStore;
    readonly transactionMonitorService: TransactionMonitorService;
    readonly transactionParser: TransactionParser;
  }) {
    this.logger = options.logger.child({ component: "block-processor" });
    this.rpcClient = options.rpcClient;
    this.stateStore = options.stateStore;
    this.transactionMonitorService = options.transactionMonitorService;
    this.transactionParser = options.transactionParser;
  }

  public async initialize(): Promise<void> {
    const persistedHeight = this.stateStore.getLastProcessedHeight();
    if (persistedHeight !== null) {
      this.currentHeight = persistedHeight;
      this.targetHeight = persistedHeight;
      this.logger.info({ height: persistedHeight }, "Loaded persisted checkpoint");
      return;
    }

    const latestHeight = await this.rpcClient.getLatestHeight();
    await this.stateStore.setLastProcessedHeight(latestHeight);
    this.currentHeight = latestHeight;
    this.targetHeight = latestHeight;
    this.logger.info(
      { height: latestHeight },
      "Initialized checkpoint from current chain height",
    );
  }

  public scheduleCatchUp(height: number): void {
    if (height <= this.targetHeight) {
      return;
    }

    this.logger.info(
      { currentHeight: this.currentHeight, nextTargetHeight: height },
      "Queued block catch-up",
    );
    this.targetHeight = height;
    void this.run();
  }

  public getCurrentHeight(): number {
    return this.currentHeight;
  }

  private async run(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      while (this.currentHeight < this.targetHeight) {
        const nextHeight = this.currentHeight + 1;
        await retryWithBackoff(
          async () => {
            await this.processBlock(nextHeight);
          },
          {
            initialDelayMs: 1_000,
            maxAttempts: 5,
            maxDelayMs: 15_000,
            onRetry: async (error, attempt, delayMs) => {
              this.logger.warn(
                { attempt, delayMs, error, height: nextHeight },
                "Retrying block processing",
              );
            },
          },
        );

        this.currentHeight = nextHeight;
        await this.stateStore.setLastProcessedHeight(this.currentHeight);
      }
    } catch (error) {
      this.logger.error({ error, height: this.currentHeight }, "Block processor loop failed");
      setTimeout(() => void this.run(), 1_000);
    } finally {
      this.running = false;
      if (this.currentHeight < this.targetHeight) {
        setTimeout(() => void this.run(), 0);
      }
    }
  }

  private async processBlock(height: number): Promise<void> {
    this.logger.debug({ height }, "Fetching block for processing");
    const [block, blockResults] = await Promise.all([
      this.rpcClient.getBlock(height),
      this.rpcClient.getBlockResults(height),
    ]);

    for (const [index, txBase64] of block.txs.entries()) {
      const transaction = this.transactionParser.parseTransaction({
        height,
        ...(block.timestamp ? { timestamp: block.timestamp } : {}),
        txBase64,
        ...(blockResults[index] ? { txResult: blockResults[index] } : {}),
      });

      await this.transactionMonitorService.handleTransaction(transaction);
    }

    this.logger.info({ height, txCount: block.txs.length }, "Processed block");
  }
}
