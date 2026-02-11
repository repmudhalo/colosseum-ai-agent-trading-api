export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  factor?: number;
  jitterMs?: number;
  onRetry?: (input: { attempt: number; nextDelayMs: number; error: unknown }) => Promise<void> | void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function retryWithBackoff<T>(
  work: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const factor = opts.factor ?? 2;
  const jitterMs = opts.jitterMs ?? 25;

  let attempt = 0;

  while (true) {
    attempt += 1;

    try {
      return await work();
    } catch (error) {
      if (attempt >= opts.maxAttempts) {
        throw error;
      }

      const exponential = opts.baseDelayMs * factor ** (attempt - 1);
      const bounded = Math.min(exponential, opts.maxDelayMs ?? exponential);
      const jitter = Math.floor(Math.random() * jitterMs);
      const nextDelayMs = Math.max(0, Math.floor(bounded + jitter));

      await opts.onRetry?.({ attempt, nextDelayMs, error });
      await sleep(nextDelayMs);
    }
  }
}
