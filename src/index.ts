import "dotenv/config";

import { TelegramBotService } from "./bot/telegramBot";
import { BlockProcessor } from "./listener/blockProcessor";
import { PollingFallback } from "./listener/pollingFallback";
import { RpcClient } from "./listener/rpcClient";
import { WebsocketListener } from "./listener/wsListener";
import { TransactionParser } from "./parser/txParser";
import { NotificationService } from "./services/notificationService";
import { StateStore } from "./services/stateStore";
import { TransactionMonitorService } from "./services/transactionMonitorService";
import { loadConfig } from "./utils/config";
import { logger } from "./utils/logger";

async function main(): Promise<void> {
  const config = loadConfig();
  const appLogger = logger.child({ service: "zigchain-wallet-monitor" });
  const stateStore = new StateStore(config.stateFilePath);
  await stateStore.load();

  const telegramBotService = new TelegramBotService({
    logger: appLogger,
    stateStore,
    telegramBotToken: config.telegramBotToken,
    trackedWallets: config.trackedWallets,
  });

  const notificationService = new NotificationService({
    logger: appLogger,
    telegramBotService,
  });

  const transactionMonitorService = new TransactionMonitorService({
    logger: appLogger,
    notificationService,
    trackedWallets: config.trackedWallets,
  });

  const rpcClient = new RpcClient({
    logger: appLogger,
    rpcUrl: config.rpcUrl,
    timeoutMs: config.rpcRequestTimeoutMs,
  });

  const transactionParser = new TransactionParser();
  const blockProcessor = new BlockProcessor({
    logger: appLogger,
    rpcClient,
    stateStore,
    transactionMonitorService,
    transactionParser,
  });

  await telegramBotService.launch();
  await blockProcessor.initialize();

  const scheduleHeight = (height: number): void => {
    blockProcessor.scheduleCatchUp(height);
  };

  const websocketListener = new WebsocketListener({
    heartbeatMs: config.wsHeartbeatMs,
    logger: appLogger,
    onHeight: scheduleHeight,
    reconnectBaseDelayMs: config.reconnectBaseDelayMs,
    reconnectMaxDelayMs: config.reconnectMaxDelayMs,
    staleMs: config.wsStaleMs,
    wsUrl: config.wsUrl,
  });

  const pollingFallback = new PollingFallback({
    intervalMs: config.pollIntervalMs,
    logger: appLogger,
    onHeight: scheduleHeight,
    rpcClient,
  });

  websocketListener.start();
  pollingFallback.start();

  appLogger.info(
    { trackedWalletCount: config.trackedWallets.length },
    "ZigChain wallet monitor started",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    appLogger.info({ signal }, "Shutting down");
    pollingFallback.stop();
    websocketListener.stop();
    await telegramBotService.stop(signal);
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main().catch((error) => {
  logger.fatal({ error }, "Application failed to start");
  process.exit(1);
});
