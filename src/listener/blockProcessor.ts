import type { Logger } from "pino";

import type { TransactionParser } from "../parser/txParser";
import type { TrackedWallet } from "../types/blockchain";
import type { TransactionMonitorService } from "../services/transactionMonitorService";
import { retryWithBackoff } from "../utils/retry";
import type { RpcClient, RpcIndexedTransaction } from "./rpcClient";
import { buildWalletTxSearchQueries, type WalletScopedQuery } from "./walletQueries";

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

  private readonly searchQueries: readonly WalletScopedQuery[];

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
    this.searchQueries = buildWalletTxSearchQueries(options.trackedWallets);
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
    this.logger.debug(
      { height, queryCount: this.searchQueries.length },
      "Searching tracked-wallet transactions for height",
    );

    const transactionsByHash = new Map<string, RpcIndexedTransaction>();
    for (const query of this.searchQueries) {
      const batch = await retryWithBackoff(
        async () => this.rpcClient.searchTransactions(query.query, height, height),
        {
          initialDelayMs: 500,
          maxAttempts: 4,
          maxDelayMs: 5_000,
          onRetry: async (error, attempt, delayMs) => {
            this.logger.warn(
              {
                attempt,
                delayMs,
                error,
                eventKey: query.eventKey,
                height,
                query: query.query,
                walletAddress: query.walletAddress,
              },
              "Retrying wallet-scoped tx_search query",
            );
          },
        },
      );

      for (const indexedTransaction of batch) {
        transactionsByHash.set(indexedTransaction.hash, indexedTransaction);
      }
    }

    for (const indexedTransaction of transactionsByHash.values()) {
      const transaction = this.transactionParser.parseTransaction({
        height: indexedTransaction.height,
        txBase64: indexedTransaction.txBase64,
        txResult: indexedTransaction.txResult,
      });

      await this.transactionMonitorService.handleTransaction(transaction);
    }

    this.logger.info(
      { height, matchedTxCount: transactionsByHash.size },
      "Processed tracked-wallet transactions at height",
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
