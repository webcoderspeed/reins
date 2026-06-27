/**
 * Thrown (or used as an abort reason) when a scope or task is cancelled —
 * either explicitly via `scope.cancel()`, through an external `AbortSignal`,
 * or because a sibling task failed and triggered teardown.
 *
 * Use {@link isCancellation} to distinguish "this was cancelled" from
 * "this actually failed".
 */
export class CancellationError extends Error {
  override readonly name = 'CancellationError';

  constructor(message = 'Operation was cancelled', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Thrown when a scope exceeds its `timeout`. The scope's children are aborted
 * first, then `withScope` rejects with this error.
 */
export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';

  constructor(message = 'Operation timed out', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Returns `true` if `err` represents a cancellation rather than a genuine
 * failure — i.e. a {@link CancellationError} or a DOM/Node `AbortError`.
 *
 * Handy for code that wants to swallow "we were cancelled" but rethrow real
 * errors:
 *
 * ```ts
 * try {
 *   await withScope(...);
 * } catch (err) {
 *   if (isCancellation(err)) return; // expected — user navigated away, etc.
 *   throw err;                       // a real failure
 * }
 * ```
 *
 * Note: a {@link TimeoutError} is treated as its own distinct outcome and is
 * *not* reported as a cancellation by this helper.
 */
export function isCancellation(err: unknown): boolean {
  if (err instanceof CancellationError) return true;
  // `fetch`, `sleep`, and other signal-aware APIs reject with an AbortError
  // (a DOMException in browsers / modern Node) when their signal aborts.
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Internal: coerce an arbitrary abort reason into a typed error we can throw.
 * Pass-through for our own error types so the root cause is preserved.
 */
export function toCancellation(reason: unknown): CancellationError | TimeoutError {
  if (reason instanceof CancellationError || reason instanceof TimeoutError) {
    return reason;
  }
  return new CancellationError('Operation was cancelled', { cause: reason });
}
