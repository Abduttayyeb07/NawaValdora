export interface RetryOptions {
  readonly factor?: number;
  readonly initialDelayMs?: number;
  readonly maxAttempts?: number;
  readonly maxDelayMs?: number;
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void | Promise<void>;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    factor = 2,
    initialDelayMs = 500,
    maxAttempts = 5,
    maxDelayMs = 10_000,
    onRetry,
  } = options;

  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;

    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }

      const exponentialDelay = Math.min(initialDelayMs * factor ** (attempt - 1), maxDelayMs);
      const jitter = Math.floor(Math.random() * 250);
      const delayMs = exponentialDelay + jitter;

      await onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
