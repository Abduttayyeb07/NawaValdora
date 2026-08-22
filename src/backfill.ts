import "dotenv/config";

import { TelegramBotService } from "./bot/telegramBot";
import { BlockProcessor } from "./listener/blockProcessor";
import { RpcClient } from "./listener/rpcClient";
import { TransactionParser } from "./parser/txParser";
import { NotificationService } from "./services/notificationService";
import { StateStore } from "./services/stateStore";
import { TransactionMonitorService } from "./services/transactionMonitorService";
import { loadConfig } from "./utils/config";
import { logger } from "./utils/logger";

const START_HEIGHT = parseInt(process.env.BACKFILL_START ?? "0", 10);
const END_HEIGHT   = parseInt(process.env.BACKFILL_END   ?? "0", 10);
const WORKER_COUNT = parseInt(process.env.BACKFILL_WORKERS ?? "20", 10);

if (!START_HEIGHT || !END_HEIGHT || START_HEIGHT >= END_HEIGHT) {
  logger.fatal(
    { BACKFILL_END: END_HEIGHT, BACKFILL_START: START_HEIGHT },
    "Set BACKFILL_START and BACKFILL_END env vars (BACKFILL_START < BACKFILL_END)",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = logger.child({ service: "backfill" });

  log.info(
    { endHeight: END_HEIGHT, startHeight: START_HEIGHT, workers: WORKER_COUNT },
    "Starting backfill — main bot continues running normally",
  );

  const stateStore = new StateStore(config.subscribersFilePath);
  await stateStore.load();

  const telegramBotService = new TelegramBotService({
    logger: log,
    stateStore,
    telegramBotToken: config.telegramBotToken,
    trackedWallets: config.trackedWallets,
  });

  void telegramBotService.launch().catch((err: unknown) => {
    log.error({ err }, "Telegram bot launch failed");
  });

  const notificationService = new NotificationService({
    logger: log,
    telegramBotService,
  });

  const transactionMonitorService = new TransactionMonitorService({
    logger: log,
    notificationService,
    trackedWallets: config.trackedWallets,
  });

  const rpcClient = new RpcClient({
    logger: log,
    rpcUrl: config.rpcUrl,
    timeoutMs: config.rpcRequestTimeoutMs,
  });

  const blockProcessor = new BlockProcessor({
    logger: log,
    rpcClient,
    trackedWallets: config.trackedWallets,
    transactionMonitorService,
    transactionParser: new TransactionParser(),
    workerCount: WORKER_COUNT,
  });

  blockProcessor.startBackfill(START_HEIGHT, END_HEIGHT);

  // Poll every 5s and log progress until done
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      const current = blockProcessor.getCurrentHeight();
      const remaining = END_HEIGHT - current;
      log.info({ current, endHeight: END_HEIGHT, remaining }, "Backfill progress");
      if (current >= END_HEIGHT) {
        clearInterval(interval);
        resolve();
      }
    }, 5_000);
  });

  log.info({ endHeight: END_HEIGHT, startHeight: START_HEIGHT }, "✅ Backfill complete — all alerts sent");
  await telegramBotService.stop("done");
  process.exit(0);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "Backfill script failed");
  process.exit(1);
});
