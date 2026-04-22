import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface TelegramSubscriber {
  readonly chatId: string;
  readonly chatTitle?: string;
  readonly chatType: string;
  readonly username?: string;
}

export interface AppState {
  readonly lastProcessedHeight: number | null;
  readonly subscribers: TelegramSubscriber[];
  readonly updatedAt: string;
}

function createDefaultState(): AppState {
  return {
    lastProcessedHeight: null,
    subscribers: [],
    updatedAt: new Date().toISOString(),
  };
}

export class StateStore {
  private readonly filePath: string;

  private state: AppState = createDefaultState();

  public constructor(filePath: string) {
    this.filePath = filePath;
  }

  public async load(): Promise<AppState> {
    await mkdir(dirname(this.filePath), { recursive: true });

    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as Partial<AppState>;
      this.state = {
        lastProcessedHeight:
          typeof parsed.lastProcessedHeight === "number" ? parsed.lastProcessedHeight : null,
        subscribers: Array.isArray(parsed.subscribers)
          ? parsed.subscribers.filter(
              (subscriber): subscriber is TelegramSubscriber =>
                typeof subscriber === "object" &&
                subscriber !== null &&
                typeof subscriber.chatId === "string" &&
                typeof subscriber.chatType === "string",
            )
          : [],
        updatedAt:
          typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      };
    } catch {
      this.state = createDefaultState();
      await this.persist();
    }

    return this.snapshot();
  }

  public getLastProcessedHeight(): number | null {
    return this.state.lastProcessedHeight;
  }

  public async setLastProcessedHeight(height: number): Promise<void> {
    this.state = {
      ...this.state,
      lastProcessedHeight: height,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
  }

  public listSubscribers(): TelegramSubscriber[] {
    return [...this.state.subscribers];
  }

  public async addSubscriber(subscriber: TelegramSubscriber): Promise<void> {
    const subscribers = this.state.subscribers.filter(
      (existingSubscriber) => existingSubscriber.chatId !== subscriber.chatId,
    );
    subscribers.push(subscriber);

    this.state = {
      ...this.state,
      subscribers,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
  }

  public async removeSubscriber(chatId: string): Promise<boolean> {
    const nextSubscribers = this.state.subscribers.filter(
      (subscriber) => subscriber.chatId !== chatId,
    );

    if (nextSubscribers.length === this.state.subscribers.length) {
      return false;
    }

    this.state = {
      ...this.state,
      subscribers: nextSubscribers,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    return true;
  }

  public snapshot(): AppState {
    return {
      lastProcessedHeight: this.state.lastProcessedHeight,
      subscribers: [...this.state.subscribers],
      updatedAt: this.state.updatedAt,
    };
  }

  private async persist(): Promise<void> {
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}
