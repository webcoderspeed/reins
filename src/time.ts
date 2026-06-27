import { toCancellation } from './errors.js';
import { withScope } from './scope.js';

/**
 * A cancellable delay. Resolves after `ms` milliseconds, or rejects promptly
 * if `signal` aborts first — so it unwinds cleanly inside a {@link withScope}.
 *
 * @example
 * ```ts
 * await withScope(async (scope) => {
 *   await sleep(1000, scope.signal); // rejects immediately if the scope cancels
 * });
 * ```
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(toCancellation(signal.reason));
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(toCancellation(signal?.reason));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Sugar for running a single task with a deadline. Equivalent to a one-task
 * scope: the task is aborted and a `TimeoutError` is thrown if it doesn't
 * finish within `ms`.
 *
 * @example
 * ```ts
 * const data = await withTimeout((signal) => fetch(url, { signal }), 1000);
 * ```
 */
export function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T> | T,
  ms: number,
): Promise<T> {
  return withScope((scope) => scope.spawn(task), { timeout: ms });
}
