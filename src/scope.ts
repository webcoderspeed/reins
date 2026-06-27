import { CancellationError, TimeoutError, toCancellation, isCancellation } from './errors.js';
import { liftListenerCap } from './internal.js';

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
   * its siblings (subject to `concurrency`) and receives the scope's signal.
   *
   * Returns a promise for the task's result. Ignoring this promise never
   * produces an `unhandledRejection` — a failure surfaces through the scope.
   */
  spawn<T>(task: (signal: AbortSignal) => Promise<T> | T): Promise<T>;

  /**
   * Spawn several tasks at once and await all their results, in order.
   * Shorthand for `Promise.all([...].map(scope.spawn))`.
   */
  spawnAll<T>(tasks: Iterable<(signal: AbortSignal) => Promise<T> | T>): Promise<T[]>;

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
  /** Max tasks running at once. Extra `spawn`s queue until a slot frees. Default: unlimited. */
  concurrency?: number;
}

/**
 * A manually-managed scope returned by {@link createScope}. Disposable so it
 * can be used with `await using`; also exposes an explicit {@link dispose} for
 * runtimes (or toolchains) without `await using` support.
 */
export interface ScopeHandle extends Scope, AsyncDisposable {
  /**
   * Tear the scope down: cancel children, await their teardown, then re-throw
   * the first *real* failure (cancellations are swallowed as expected control
   * flow). Idempotent. Called automatically by `await using`.
   */
  dispose(): Promise<void>;
}

interface ScopeCore {
  scope: Scope;
  join(): Promise<void>;
  fail(cause: unknown): void;
  teardown(): void;
  isFailed(): boolean;
  rootCause(): unknown;
}

/** Build the shared scope machinery used by both {@link withScope} and {@link createScope}. */
function makeScope(options: WithScopeOptions): ScopeCore {
  const controller = new AbortController();
  const { signal } = controller;
  // A wide fan-out of tasks forwarding this signal shouldn't warn on Node.
  liftListenerCap(signal);

  // Trackers for every spawned task. Each tracker always resolves (never
  // rejects): failures are routed into `fail()` and swallowed here so the
  // join can't throw and an ignored `spawn()` result can't leak.
  const tasks: Promise<void>[] = [];

  // The first failure/cancellation wins and becomes what the scope throws.
  let rootCause: unknown;
  let failed = false;

  // ---- concurrency limiter (inert unless `concurrency` is a finite number) ----
  const limit = options.concurrency && options.concurrency > 0 ? options.concurrency : Infinity;
  const limited = limit !== Infinity;
  let active = 0;
  // Each waiter attempts to acquire when called; returns true once it settles.
  const waiters: Array<() => boolean> = [];

  const flushWaiters = (): void => {
    // On abort, wake every queued waiter so it can reject promptly.
    while (waiters.length > 0) waiters.shift()!();
  };

  const acquire = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const tryAcquire = (): boolean => {
        if (signal.aborted) {
          reject(toCancellation(signal.reason));
          return true;
        }
        if (active < limit) {
          active++;
          resolve();
          return true;
        }
        return false;
      };
      if (!tryAcquire()) waiters.push(tryAcquire);
    });

  const release = (): void => {
    active--;
    while (waiters.length > 0 && active < limit) waiters.shift()!();
  };

  // ---- failure funnel ----
  const fail = (cause: unknown): void => {
    if (!failed) {
      failed = true;
      rootCause = cause;
    }
    if (!signal.aborted) controller.abort(cause);
    flushWaiters();
  };

  const cancel = (reason?: unknown): void => {
    fail(reason ?? new CancellationError('Scope was cancelled'));
  };

  const spawn = <U>(task: (signal: AbortSignal) => Promise<U> | U): Promise<U> => {
    const result = (async () => {
      if (signal.aborted) throw toCancellation(signal.reason);
      if (!limited) return await task(signal);
      await acquire(); // rejects if the scope aborts while queued
      try {
        if (signal.aborted) throw toCancellation(signal.reason);
        return await task(signal);
      } finally {
        release();
      }
    })();

    // Attaching this handler both lets the scope join the task and marks
    // `result` as handled (so ignoring it never triggers unhandledRejection).
    // `fail` dedupes, so a forwarded-abort error won't clobber the real cause.
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

  const spawnAll = <U>(taskList: Iterable<(signal: AbortSignal) => Promise<U> | U>): Promise<U[]> =>
    Promise.all(Array.from(taskList, (t) => spawn(t)));

  /** Wait for every tracker — including ones spawned *while* we wait. */
  const join = async (): Promise<void> => {
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  };

  // ---- external signal + timeout wiring ----
  const externalSignal = options.signal;
  const onExternalAbort = (): void => {
    fail(new CancellationError('Scope cancelled by external signal', { cause: externalSignal?.reason }));
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeout !== undefined) {
    timer = setTimeout(() => {
      const label = options.name ? `Scope "${options.name}"` : 'Scope';
      fail(new TimeoutError(`${label} timed out after ${options.timeout}ms`));
    }, options.timeout);
    // Don't let a pending timeout keep the process alive (Node only).
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  const teardown = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    // Tear the scope down so any lingering listeners detach.
    if (!signal.aborted) controller.abort(new CancellationError('Scope exited'));
  };

  const scope: Scope = { signal, spawn, spawnAll, cancel };
  return {
    scope,
    join,
    fail,
    teardown,
    isFailed: () => failed,
    rootCause: () => rootCause,
  };
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
  const core = makeScope(options);
  try {
    let result: T;
    try {
      result = await body(core.scope);
    } catch (err) {
      core.fail(err);
      await core.join();
      throw core.rootCause();
    }
    // Body resolved — but join-on-exit means we still wait for every task.
    await core.join();
    if (core.isFailed()) throw core.rootCause();
    return result;
  } finally {
    core.teardown();
  }
}

const NATIVE_ASYNC_DISPOSE: symbol | undefined = (Symbol as { asyncDispose?: symbol }).asyncDispose;

/**
 * Create a scope you manage yourself, for use with `await using` (or an explicit
 * `try`/`finally`). Spawn tasks into it; when the block exits, the scope cancels
 * any unfinished children, waits for them to unwind, and re-throws the first
 * real failure.
 *
 * @example
 * ```ts
 * await using scope = createScope({ timeout: 5000 });
 * const user = scope.spawn((s) => fetch(`/u/${id}`, { signal: s }));
 * const data = await user;
 * // ← at block end the scope tears down; nothing leaks.
 * ```
 *
 * On runtimes without `await using` (Node < 24 with no polyfill), use the
 * explicit form:
 *
 * ```ts
 * const scope = createScope();
 * try {
 *   await scope.spawn(work);
 * } finally {
 *   await scope.dispose();
 * }
 * ```
 */
export function createScope(options: WithScopeOptions = {}): ScopeHandle {
  const core = makeScope(options);
  let disposed = false;

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    if (!core.isFailed()) core.fail(new CancellationError('Scope disposed'));
    await core.join();
    core.teardown();
    const cause = core.rootCause();
    // Surface genuine failures (errors, timeouts); swallow cancellations.
    if (core.isFailed() && !isCancellation(cause)) throw cause;
  };

  const handle: Record<PropertyKey, unknown> = {
    signal: core.scope.signal,
    spawn: core.scope.spawn,
    spawnAll: core.scope.spawnAll,
    cancel: core.scope.cancel,
    dispose,
  };
  // Wire `await using` only where the well-known symbol exists at runtime.
  if (NATIVE_ASYNC_DISPOSE) handle[NATIVE_ASYNC_DISPOSE] = dispose;

  return handle as unknown as ScopeHandle;
}
