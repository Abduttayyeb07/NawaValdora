import type { Logger } from "pino";

import type { TransactionParser } from "../parser/txParser";
import type { TrackedWallet } from "../types/blockchain";
import type { TransactionMonitorService } from "../services/transactionMonitorService";
import { retryWithBackoff } from "../utils/retry";
import type { RpcClient } from "./rpcClient";

export class BlockProcessor {
  private activeWorkers = 0;

  private checkpointAdvancePromise: Promise<void> = Promise.resolve();

  private readonly completedHeights = new Set<number>();

  private currentHeight = 0;

  private readonly inFlightHeights = new Set<number>();

  private latestObservedHeight = 0;

  private readonly logger: Logger;

  private readonly pendingHeights: number[] = [];

  private readonly queuedHeights = new Set<number>();

  private readonly rpcClient: RpcClient;

  private targetHeight = 0;

  private readonly transactionMonitorService: TransactionMonitorService;

  private readonly transactionParser: TransactionParser;

  private readonly workerCount: number;

  public constructor(options: {
    readonly logger: Logger;
    readonly rpcClient: RpcClient;
    readonly trackedWallets: readonly TrackedWallet[];
    readonly transactionMonitorService: TransactionMonitorService;
    readonly transactionParser: TransactionParser;
    readonly workerCount: number;
  }) {
    this.logger = options.logger.child({ component: "block-processor" });
    this.rpcClient = options.rpcClient;
    this.transactionMonitorService = options.transactionMonitorService;
    this.transactionParser = options.transactionParser;
    this.workerCount = options.workerCount;
  }

  public async initialize(): Promise<void> {
    const latestHeight = await this.rpcClient.getLatestHeight();
    this.currentHeight = latestHeight;
    this.latestObservedHeight = latestHeight;
    this.targetHeight = latestHeight;
    this.logger.info(
      { height: latestHeight, workerCount: this.workerCount },
      "Initialized checkpoint from current chain height",
    );
  }

  public scheduleCatchUp(height: number): void {
    if (height <= this.currentHeight && height <= this.targetHeight) {
      return;
    }

    const previousTarget = this.targetHeight;
    this.latestObservedHeight = Math.max(this.latestObservedHeight, height);
    this.targetHeight = this.latestObservedHeight;

    const addedHeights = this.enqueuePendingHeights(Math.max(previousTarget + 1, this.currentHeight + 1));
    this.logger.info(
      {
        activeWorkers: this.activeWorkers,
        addedHeights,
        currentHeight: this.currentHeight,
        latestObservedHeight: this.latestObservedHeight,
        nextTargetHeight: this.targetHeight,
      },
      "Queued block catch-up",
    );
    this.ensureWorkers();
  }

  public getCurrentHeight(): number {
    return this.currentHeight;
  }

  private async advanceCheckpoint(): Promise<void> {
    let nextHeight = this.currentHeight + 1;
    let advancedTo = this.currentHeight;

    while (this.completedHeights.has(nextHeight)) {
      this.completedHeights.delete(nextHeight);
      this.queuedHeights.delete(nextHeight);
      advancedTo = nextHeight;
      nextHeight += 1;
    }

    if (advancedTo === this.currentHeight) {
      return;
    }

    this.currentHeight = advancedTo;
    this.logger.info(
      {
        activeWorkers: this.activeWorkers,
        currentHeight: this.currentHeight,
        pendingHeights: this.pendingHeights.length,
        targetHeight: this.targetHeight,
      },
      "Advanced block checkpoint",
    );
  }

  private enqueuePendingHeights(startHeight: number): number {
    let addedHeights = 0;
    const safeStartHeight = Math.max(startHeight, this.currentHeight + 1);

    for (let height = safeStartHeight; height <= this.latestObservedHeight; height += 1) {
      if (
        this.queuedHeights.has(height) ||
        this.inFlightHeights.has(height) ||
        this.completedHeights.has(height)
      ) {
        continue;
      }

      this.pendingHeights.push(height);
      this.queuedHeights.add(height);
      addedHeights += 1;
    }

    return addedHeights;
  }

  private ensureWorkers(): void {
    while (this.activeWorkers < this.workerCount && this.pendingHeights.length > 0) {
      const nextHeight = this.pendingHeights.shift();
      if (nextHeight === undefined) {
        return;
      }

      if (nextHeight <= this.currentHeight || nextHeight > this.latestObservedHeight) {
        this.queuedHeights.delete(nextHeight);
        continue;
      }

      this.activeWorkers += 1;
      this.inFlightHeights.add(nextHeight);
      this.logger.debug(
        {
          activeWorkers: this.activeWorkers,
          currentHeight: this.currentHeight,
          height: nextHeight,
          targetHeight: this.targetHeight,
        },
        "Dispatching block worker",
      );
      void this.runWorker(nextHeight);
    }
  }

  private async processBlock(height: number): Promise<void> {
    this.logger.debug({ height }, "Fetching block for processing");

    const [block, txResults] = await Promise.all([
      this.rpcClient.getBlock(height),
      this.rpcClient.getBlockResults(height),
    ]);

    if (block.txs.length === 0) {
      this.logger.debug({ height }, "Empty block, skipping");
      return;
    }

    for (let i = 0; i < block.txs.length; i++) {
      const txBase64 = block.txs[i];
      if (!txBase64) continue;

      const txResult = txResults[i] ?? { code: 0, events: [] };
      const transaction = this.transactionParser.parseTransaction({
        height,
        ...(block.timestamp ? { timestamp: block.timestamp } : {}),
        txBase64,
        txResult,
      });

      await this.transactionMonitorService.handleTransaction(transaction);
    }

    this.logger.info(
      { height, txCount: block.txs.length },
      "Processed block",
    );
  }

  private queueCheckpointAdvance(): Promise<void> {
    this.checkpointAdvancePromise = this.checkpointAdvancePromise.then(
      async () => {
        await this.advanceCheckpoint();
      },
      async () => {
        await this.advanceCheckpoint();
      },
    );

    return this.checkpointAdvancePromise;
  }

  private async runWorker(height: number): Promise<void> {
    try {
      await retryWithBackoff(
        async () => {
          await this.processBlock(height);
        },
        {
          initialDelayMs: 1_000,
          maxAttempts: 5,
          maxDelayMs: 15_000,
          onRetry: async (error, attempt, delayMs) => {
            this.logger.warn(
              { attempt, delayMs, error, height },
              "Retrying block processing",
            );
          },
        },
      );

      this.completedHeights.add(height);
      await this.queueCheckpointAdvance();
    } catch (error) {
      this.logger.error(
        { error, height },
        "Block worker failed after retries; re-queueing height",
      );
      this.pendingHeights.unshift(height);
    } finally {
      this.inFlightHeights.delete(height);
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      this.ensureWorkers();
    }
  }
}
