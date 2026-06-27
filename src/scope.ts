import { CancellationError, TimeoutError, toCancellation } from './errors.js';

/**
 * A scope (a.k.a. nursery) owns the async tasks started inside it. When the
 * scope exits, every task it started is guaranteed to be finished or cancelled.
 */
export interface Scope {
  /**
   * Aborted when the scope tears down — on completion, error, timeout, or
   * cancellation. Forward it to `fetch`, {@link sleep}, DB drivers, etc. so
   * their work unwinds promptly.
   */
  readonly signal: AbortSignal;

  /**
   * Start a child task bound to this scope. The task runs concurrently with
   * its siblings and receives the scope's {@link Scope.signal}.
   *
   * Returns a promise for the task's result. Ignoring this promise never
   * produces an `unhandledRejection` — a failure surfaces through the scope
   * instead.
   */
  spawn<T>(task: (signal: AbortSignal) => Promise<T> | T): Promise<T>;

  /** Cancel the whole scope (and all children) now. */
  cancel(reason?: unknown): void;
}

export interface WithScopeOptions {
  /** External cancellation — when this signal aborts, the scope cancels. */
  signal?: AbortSignal;
  /** Milliseconds — cancel the whole scope after this long, rejecting with {@link TimeoutError}. */
  timeout?: number;
  /** Label for debugging and error messages. */
  name?: string;
}

/**
 * Run `body(scope)` inside a structured-concurrency scope.
 *
 * `withScope` does not resolve until **every** task spawned in the scope has
 * settled or been cancelled — even tasks the body never awaited. If any task
 * (or the body) throws, the remaining tasks are aborted and `withScope`
 * rejects with that root-cause error. A `timeout` or an external `signal`
 * abort tears the whole scope down the same way.
 *
 * @example
 * ```ts
 * const [user, orders] = await withScope(async (scope) => {
 *   const u = scope.spawn((signal) => fetch(`/u/${id}`, { signal }));
 *   const o = scope.spawn((signal) => fetch(`/o/${id}`, { signal }));
 *   return Promise.all([u, o]);
 * }, { timeout: 5000 });
 * ```
 */
export async function withScope<T>(
  body: (scope: Scope) => Promise<T> | T,
  options: WithScopeOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const { signal } = controller;

  // Trackers for every spawned task. Each tracker always resolves (never
  // rejects): failures are routed into `fail()` and swallowed here so the
  // join below can't throw and an ignored `spawn()` result can't leak.
  const tasks: Promise<void>[] = [];

  // The first failure/cancellation wins and becomes what the scope throws.
  let rootCause: unknown;
  let failed = false;

  /** Single funnel for every way the scope can tear down. First cause wins. */
  const fail = (cause: unknown): void => {
    if (!failed) {
      failed = true;
      rootCause = cause;
    }
    if (!signal.aborted) controller.abort(cause);
  };

  const cancel = (reason?: unknown): void => {
    fail(reason ?? new CancellationError('Scope was cancelled'));
  };

  const spawn = <U>(task: (signal: AbortSignal) => Promise<U> | U): Promise<U> => {
    const result = (async () => {
      // Don't start new work once the scope is already tearing down.
      if (signal.aborted) throw toCancellation(signal.reason);
      return await task(signal);
    })();

    // Attaching this handler to `result` both (a) lets the scope join on the
    // task and (b) marks `result` as handled, so ignoring the returned promise
    // never triggers an unhandledRejection. `fail` dedupes, so a secondary
    // abort error from a forwarded signal won't clobber the real root cause.
    tasks.push(
      result.then(
        () => {},
        (err) => {
          fail(err);
        },
      ),
    );

    return result;
  };

  /** Wait for every tracker — including ones spawned *while* we wait. */
  const join = async (): Promise<void> => {
    for (let i = 0; i < tasks.length; i++) {
      await tasks[i];
    }
  };

  const externalSignal = options.signal;
  const onExternalAbort = (): void => {
    fail(new CancellationError('Scope cancelled by external signal', { cause: externalSignal?.reason }));
  };

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    if (options.timeout !== undefined) {
      timer = setTimeout(() => {
        const label = options.name ? `Scope "${options.name}"` : 'Scope';
        fail(new TimeoutError(`${label} timed out after ${options.timeout}ms`));
      }, options.timeout);
      // Don't let a pending timeout keep the process alive (Node only).
      (timer as unknown as { unref?: () => void }).unref?.();
    }

    let bodyResult: T;
    try {
      bodyResult = await body({ signal, spawn, cancel });
    } catch (err) {
      fail(err);
      await join();
      throw rootCause;
    }

    // Body resolved — but join-on-exit means we still wait for every task.
    await join();
    if (failed) throw rootCause;
    return bodyResult;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    // Tear the scope down on the way out so any lingering listeners detach.
    if (!signal.aborted) controller.abort(new CancellationError('Scope exited'));
  }
}
