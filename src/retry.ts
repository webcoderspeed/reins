import { sleep } from './time.js';
import { isCancellation } from './errors.js';

export interface RetryOptions {
  /** Maximum total attempts, including the first. Default: 3. */
  attempts?: number;
  /** Base delay between attempts, in ms. Default: 100. */
  delay?: number;
  /** Exponential backoff multiplier applied each retry. Default: 2. */
  factor?: number;
  /** Upper bound on the computed delay, in ms. Default: unbounded. */
  maxDelay?: number;
  /** Multiply each delay by a random factor in [0, 1) to avoid thundering herds. Default: false. */
  jitter?: boolean;
  /** Abort retrying immediately when this signal aborts. Also forwarded to the task. */
  signal?: AbortSignal;
  /** Called before each retry (not before the first attempt). */
  onRetry?: (error: unknown, attempt: number) => void;
}

/**
 * Run `task`, retrying on failure with exponential backoff.
 *
 * Cancellations are never retried — if the task throws a {@link CancellationError}
 * / `AbortError`, or `signal` aborts, `retry` stops immediately and rethrows.
 * The backoff delay itself is cancellable via `signal`, so a retry loop unwinds
 * promptly inside a {@link withScope}.
 *
 * @example
 * ```ts
 * const data = await withScope((scope) =>
 *   retry((s) => fetch(url, { signal: s }).then((r) => r.json()), {
 *     attempts: 5,
 *     delay: 200,
 *     signal: scope.signal,
 *   }),
 * );
 * ```
 */
export async function retry<T>(
  task: (signal?: AbortSignal) => Promise<T> | T,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const baseDelay = options.delay ?? 100;
  const factor = options.factor ?? 2;
  const maxDelay = options.maxDelay ?? Infinity;
  const { signal, onRetry, jitter } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw signal.reason;
    try {
      return await task(signal);
    } catch (err) {
      lastError = err;
      // Cancellation is intentional teardown, never a retryable failure.
      if (isCancellation(err) || signal?.aborted) throw err;
      if (attempt >= attempts) break;
      onRetry?.(err, attempt);
      let wait = Math.min(baseDelay * factor ** (attempt - 1), maxDelay);
      if (jitter) wait *= Math.random();
      await sleep(wait, signal); // cancellable backoff
    }
  }
  throw lastError;
}
