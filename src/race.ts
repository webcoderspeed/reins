import { CancellationError, TimeoutError, toCancellation } from './errors.js';
import { liftListenerCap } from './internal.js';

export interface RaceOptions {
  /** External cancellation — when this signal aborts, the race is cancelled. */
  signal?: AbortSignal;
  /** Milliseconds — cancel the race after this long, rejecting with {@link TimeoutError}. */
  timeout?: number;
  /** Label for debugging / error messages. */
  name?: string;
}

/**
 * Run every task concurrently and resolve with the **first one to succeed**,
 * cancelling the rest.
 *
 * Unlike `Promise.race` (which settles on the first task to *finish*, success or
 * failure), `race` ignores individual failures: a task that rejects simply drops
 * out, and the race keeps going. Only if **every** task fails does `race` reject
 * — with an `AggregateError` of all the failures. The losing tasks are aborted
 * via their `AbortSignal` the moment a winner appears, and `race` does not
 * resolve until they've unwound (no leaks).
 *
 * @example
 * ```ts
 * // Fastest mirror wins; the slower request is cancelled.
 * const data = await race([
 *   (signal) => fetch(mirrorA, { signal }).then((r) => r.json()),
 *   (signal) => fetch(mirrorB, { signal }).then((r) => r.json()),
 * ], { timeout: 3000 });
 * ```
 */
export async function race<T>(
  tasks: Iterable<(signal: AbortSignal) => Promise<T> | T>,
  options: RaceOptions = {},
): Promise<T> {
  const taskList = Array.from(tasks);
  if (taskList.length === 0) {
    throw new AggregateError([], 'race: no tasks provided');
  }

  const controller = new AbortController();
  const { signal } = controller;
  liftListenerCap(signal);

  const abortWith = (reason: unknown): void => {
    if (!signal.aborted) controller.abort(reason);
  };

  const externalSignal = options.signal;
  const onExternalAbort = (): void => {
    abortWith(new CancellationError('Race cancelled by external signal', { cause: externalSignal?.reason }));
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeout !== undefined) {
    timer = setTimeout(() => {
      const label = options.name ? `Race "${options.name}"` : 'Race';
      abortWith(new TimeoutError(`${label} timed out after ${options.timeout}ms`));
    }, options.timeout);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  let winner: T;
  let hasWinner = false;
  const errors: unknown[] = [];

  const runs = taskList.map(async (task) => {
    try {
      if (signal.aborted) throw toCancellation(signal.reason);
      const value = await task(signal);
      if (!hasWinner) {
        hasWinner = true;
        winner = value;
        abortWith(new CancellationError('Race already won')); // cancel the losers
      }
    } catch (err) {
      // Only collect genuine pre-win failures; post-win cancellations are noise.
      if (!hasWinner) errors.push(err);
    }
  });

  try {
    await Promise.all(runs); // every run catches, so this joins all of them
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }

  if (hasWinner) return winner!;
  // No winner: a timeout/external abort fired, or every task failed.
  if (signal.aborted) throw toCancellation(signal.reason);
  throw new AggregateError(errors, 'race: all tasks failed');
}
