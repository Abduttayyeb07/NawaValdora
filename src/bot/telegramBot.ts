import { Telegraf } from "telegraf";

import type { Logger } from "pino";

import type { TrackedWallet, WalletAlert } from "../types/blockchain";
import { retryWithBackoff } from "../utils/retry";
import type { StateStore, TelegramSubscriber } from "../services/stateStore";

type SupportedChat = {
  readonly first_name?: string;
  readonly id: number;
  readonly title?: string;
  readonly type: string;
  readonly username?: string;
};

function buildSubscriberFromChat(chat: SupportedChat): TelegramSubscriber {
  const username = typeof chat.username === "string" ? chat.username : undefined;
  const chatTitle =
    "title" in chat && typeof chat.title === "string"
      ? chat.title
      : "first_name" in chat && typeof chat.first_name === "string"
        ? chat.first_name
        : undefined;

  return {
    chatId: String(chat.id),
    chatType: chat.type,
    ...(chatTitle ? { chatTitle } : {}),
    ...(username ? { username } : {}),
  };
}

function isPermanentChatError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const response = (error as { response?: { description?: string; error_code?: number } }).response;
  const description = response?.description?.toLowerCase() ?? "";

  return (
    response?.error_code === 400 ||
    response?.error_code === 403 ||
    description.includes("chat not found") ||
    description.includes("bot was blocked") ||
    description.includes("user is deactivated")
  );
}

export class TelegramBotService {
  private readonly bot: Telegraf;

  private readonly getSheetWriteCount: (() => number) | null;

  private handlersConfigured = false;

  private launched = false;

  private readonly logger: Logger;

  private readonly stateStore: StateStore;

  private readonly trackedWallets: readonly TrackedWallet[];

  public constructor(options: {
    readonly getSheetWriteCount?: () => number;
    readonly logger: Logger;
    readonly stateStore: StateStore;
    readonly telegramBotToken: string;
    readonly trackedWallets: readonly TrackedWallet[];
  }) {
    this.bot = new Telegraf(options.telegramBotToken);
    this.getSheetWriteCount = options.getSheetWriteCount ?? null;
    this.logger = options.logger.child({ component: "telegram-bot" });
    this.stateStore = options.stateStore;
    this.trackedWallets = options.trackedWallets;
  }

  public async launch(): Promise<void> {
    if (this.launched) {
      return;
    }

    this.configureHandlers();

    this.logger.info("Authenticating with Telegram Bot API");
    const botProfile = await this.bot.telegram.getMe();
    this.logger.info(
      {
        botId: botProfile.id,
        botUsername: botProfile.username,
      },
      "Telegram bot authenticated",
    );

    try {
      const commands: { command: string; description: string }[] = [
        { command: "start", description: "Subscribe this chat to alerts" },
        { command: "subscribe", description: "Subscribe this chat to alerts" },
        { command: "unsubscribe", description: "Stop alerts for this chat" },
        { command: "status", description: "Show monitor status" },
      ];

      if (this.getSheetWriteCount) {
        commands.push({ command: "report", description: "Show Google Sheets write count" });
      }

      await this.bot.telegram.setMyCommands(commands);
      this.logger.info("Telegram bot commands registered");
    } catch (error) {
      this.logger.warn({ error }, "Failed to register Telegram bot commands");
    }

    this.logger.info("Starting Telegram long polling");
    await this.bot.launch({
      dropPendingUpdates: true,
    });

    this.launched = true;
    this.logger.info("Telegram bot launched");
  }

  public async stop(reason: string): Promise<void> {
    if (!this.launched) {
      return;
    }

    this.bot.stop(reason);
    this.launched = false;
    this.logger.info({ reason }, "Telegram bot stopped");
  }

  public async broadcastAlert(message: string, alert: WalletAlert): Promise<number> {
    const subscribers = this.stateStore.listSubscribers();
    if (subscribers.length === 0) {
      this.logger.warn(
        { txHash: alert.txHash, height: alert.height },
        "No Telegram subscribers registered; alert dropped",
      );
      return 0;
    }

    let delivered = 0;
    for (const subscriber of subscribers) {
      try {
        await this.sendWithRetry(subscriber.chatId, message, alert);
        delivered += 1;
      } catch (error) {
        if (isPermanentChatError(error)) {
          await this.stateStore.removeSubscriber(subscriber.chatId);
          this.logger.warn(
            { chatId: subscriber.chatId, error, txHash: alert.txHash },
            "Removed unreachable Telegram subscriber",
          );
          continue;
        }

        this.logger.error(
          { chatId: subscriber.chatId, error, txHash: alert.txHash },
          "Telegram alert delivery failed",
        );
      }
    }

    return delivered;
  }

  private buildSubscriptionMessage(prefix: string): string {
    const wallets = this.trackedWallets.map((wallet) => `- ${wallet.label}: ${wallet.address}`).join("\n");
    return [prefix, "", "Tracked wallets:", wallets].join("\n");
  }

  private configureHandlers(): void {
    if (this.handlersConfigured) {
      return;
    }

    this.logger.info("Configuring Telegram bot handlers");
    this.bot.catch((error, ctx) => {
      this.logger.error(
        { error, chatId: ctx.chat?.id, updateType: ctx.updateType },
        "Telegram bot update handler failed",
      );
    });

    this.bot.start(async (ctx) => {
      const subscriber = buildSubscriberFromChat(ctx.chat as SupportedChat);
      await this.stateStore.addSubscriber(subscriber);
      await ctx.reply(this.buildSubscriptionMessage("Subscription enabled."));
    });

    this.bot.command("subscribe", async (ctx) => {
      const subscriber = buildSubscriberFromChat(ctx.chat as SupportedChat);
      await this.stateStore.addSubscriber(subscriber);
      await ctx.reply(this.buildSubscriptionMessage("Subscription enabled."));
    });

    this.bot.command("unsubscribe", async (ctx) => {
      const removed = await this.stateStore.removeSubscriber(String(ctx.chat.id));
      await ctx.reply(removed ? "Subscription removed." : "This chat was not subscribed.");
    });

    this.bot.command("status", async (ctx) => {
      const state = this.stateStore.snapshot();
      const lines = [
        "ZigChain monitor is running.",
        `Tracked wallets: ${this.trackedWallets.length}`,
        `Subscribed chats: ${state.subscribers.length}`,
      ];
      await ctx.reply(lines.join("\n"));
    });

    this.bot.command("report", async (ctx) => {
      if (!this.getSheetWriteCount) {
        await ctx.reply("Google Sheets integration is not configured.");
        return;
      }
      const count = this.getSheetWriteCount();
      await ctx.reply(
        count === 0
          ? "No transactions have been written to Google Sheets yet."
          : `Google Sheets: ${count} transaction${count === 1 ? "" : "s"} written since last restart.`,
      );
    });

    this.handlersConfigured = true;
  }

  private async sendWithRetry(chatId: string, message: string, alert: WalletAlert): Promise<void> {
    await retryWithBackoff(
      async () => {
        await this.bot.telegram.sendMessage(chatId, message, {
          link_preview_options: { is_disabled: true },
          parse_mode: "HTML",
        });
      },
      {
        initialDelayMs: 1_000,
        maxAttempts: 5,
        maxDelayMs: 15_000,
        onRetry: async (error, attempt, delayMs) => {
          this.logger.warn(
            { alertKind: alert.kind, attempt, chatId, delayMs, error, txHash: alert.txHash },
            "Retrying Telegram alert delivery",
          );
        },
      },
    );
  }
}
