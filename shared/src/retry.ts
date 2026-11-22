export interface RetryOptions {
  /** Wait before each new attempt; its length is the number of retries. */
  delaysMs?: readonly number[];
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `operation` until it succeeds or the delays run out, then rethrows its last error. */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  { delaysMs = DEFAULT_RETRY_DELAYS_MS, onRetry, sleep = defaultSleep }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      const delayMs = delaysMs[attempt - 1];
      if (delayMs === undefined) throw error;
      onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}
