import "dotenv/config";

import { TelegramBotService } from "./bot/telegramBot";
import { BlockProcessor } from "./listener/blockProcessor";
import { PollingFallback } from "./listener/pollingFallback";
import { RpcClient } from "./listener/rpcClient";
import { WebsocketListener } from "./listener/wsListener";
import { TransactionParser } from "./parser/txParser";
import { BalanceService } from "./services/balanceService";
import { BalanceSheetService } from "./services/balanceSheetService";
import { GoogleSheetsService } from "./services/googleSheetsService";
import { NotificationService } from "./services/notificationService";
import { StateStore } from "./services/stateStore";
import { TransactionMonitorService } from "./services/transactionMonitorService";
import { loadConfig } from "./utils/config";
import { logger } from "./utils/logger";

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const appLogger = logger.child({ service: "zigchain-wallet-monitor" });
  appLogger.info({ logLevel: process.env.LOG_LEVEL ?? "info" }, "Configuration loaded");
  const stateStore = new StateStore(config.subscribersFilePath);
  await stateStore.load();
  appLogger.info("State store loaded");

  let googleSheetsService: GoogleSheetsService | undefined;
  let balanceSheetService: BalanceSheetService | undefined;

  if (config.googleSheetId) {
    googleSheetsService = new GoogleSheetsService({
      credentialsPath: config.googleCredentialsPath,
      logger: appLogger,
      spreadsheetId: config.googleSheetId,
    });
    await googleSheetsService.initialize();
    appLogger.info("Google Sheets integration enabled");

    const balanceService = new BalanceService({
      lcdUrl: config.lcdUrl,
      logger: appLogger,
    });

    balanceSheetService = new BalanceSheetService({
      balanceService,
      broadcastMessage: (msg) => telegramBotService.broadcastMessage(msg),
      credentialsPath: config.googleCredentialsPath,
      gid: config.balanceSheetGid,
      logger: appLogger,
      spreadsheetId: config.googleSheetId,
      trackedWallets: config.trackedWallets,
    });

    await balanceSheetService.initialize();
    balanceSheetService.start();
    appLogger.info("Balance sheet scheduler started");
  } else {
    appLogger.info("Google Sheets integration disabled (GOOGLE_SHEET_ID not set)");
  }

  const telegramBotService = new TelegramBotService({
    ...(googleSheetsService ? { getSheetWriteCount: () => googleSheetsService.getWriteCount() } : {}),
    ...(balanceSheetService ? { runBalanceSnapshot: () => balanceSheetService.runSnapshot() } : {}),
    logger: appLogger,
    stateStore,
    telegramBotToken: config.telegramBotToken,
    trackedWallets: config.trackedWallets,
  });

  const notificationService = new NotificationService({
    ...(googleSheetsService ? { googleSheetsService } : {}),
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
    trackedWallets: config.trackedWallets,
    transactionMonitorService,
    transactionParser,
    workerCount: config.blockWorkerCount,
  });

  appLogger.info("Initializing block processor");
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
    trackedWallets: config.trackedWallets,
    wsUrl: config.wsUrl,
  });

  const pollingFallback = new PollingFallback({
    intervalMs: config.pollIntervalMs,
    logger: appLogger,
    onHeight: scheduleHeight,
    rpcClient,
  });

  appLogger.info("Starting WebSocket listener");
  websocketListener.start();
  appLogger.info("Starting polling fallback");
  pollingFallback.start();
  appLogger.info("Launching Telegram bot service");

  appLogger.info(
    { blockWorkerCount: config.blockWorkerCount, trackedWalletCount: config.trackedWallets.length },
    "ZigChain wallet monitor started",
  );

  let shuttingDown = false;

  const startTelegramBot = async (): Promise<void> => {
    let attempt = 0;

    while (!shuttingDown) {
      try {
        await telegramBotService.launch();
        return;
      } catch (error) {
        attempt += 1;
        const delayMs = Math.min(1_000 * 2 ** (attempt - 1), 30_000);
        appLogger.error(
          { attempt, delayMs, error },
          "Telegram bot launch failed; monitoring will continue and startup will retry",
        );
        await sleep(delayMs);
      }
    }
  };

  void startTelegramBot();

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    appLogger.info({ signal }, "Shutting down");
    balanceSheetService?.stop();
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
