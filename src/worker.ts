import { CancellationError, TimeoutError } from './errors.js';

/**
 * `reinsjs/worker` — **experimental**, Node-only.
 *
 * The one way to get *truly preemptive* cancellation in JavaScript: run work in
 * a worker thread and `terminate()` it. Unlike cooperative `AbortSignal`
 * cancellation, this stops even a task that never checks the signal — including
 * a CPU-bound infinite loop.
 *
 * The trade-off is the worker boundary: the task runs in a fresh thread, so it
 * **cannot close over outer variables** and its `input`/result must be
 * structured-cloneable. Pass everything the task needs via `input`.
 */

export interface RunInWorkerOptions {
  /** Abort to terminate the worker immediately, rejecting with {@link CancellationError}. */
  signal?: AbortSignal;
  /** Milliseconds — terminate the worker and reject with {@link TimeoutError} after this long. */
  timeout?: number;
}

// Runs inside the worker thread. Pure JS (no TS) — it is eval'd by Node.
const WORKER_BOOTSTRAP = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const fn = (0, eval)('(' + workerData.source + ')');
    const value = await fn(workerData.input);
    parentPort.postMessage({ ok: true, value });
  } catch (error) {
    parentPort.postMessage({ ok: false, error });
  }
})();
`;

/**
 * Run `task(input)` in a Node worker thread, with real (preemptive) cancellation.
 *
 * @example
 * ```ts
 * import { runInWorker } from "reinsjs/worker";
 *
 * // A CPU-bound task that ignores cancellation entirely is still killed:
 * await runInWorker((n) => { while (true) primes(n); }, 1_000_000, { timeout: 500 });
 * // → rejects with TimeoutError, and the thread is actually terminated.
 * ```
 *
 * @remarks
 * `task` must be self-contained: it runs in a separate thread and cannot
 * reference variables from the enclosing scope. Pass data via `input`
 * (must be structured-cloneable); the resolved value must be cloneable too.
 */
export async function runInWorker<A, T>(
  task: (input: A) => T | Promise<T>,
  input?: A,
  options: RunInWorkerOptions = {},
): Promise<Awaited<T>> {
  let WorkerCtor: typeof import('node:worker_threads').Worker;
  try {
    ({ Worker: WorkerCtor } = await import('node:worker_threads'));
  } catch {
    throw new Error('runInWorker requires Node.js worker_threads, which is unavailable in this runtime');
  }

  const { signal, timeout } = options;
  if (signal?.aborted) {
    throw new CancellationError('Aborted before the worker started', { cause: signal.reason });
  }

  return await new Promise<Awaited<T>>((resolve, reject) => {
    const worker = new WorkerCtor(WORKER_BOOTSTRAP, {
      eval: true,
      workerData: { source: task.toString(), input },
    });

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      void worker.terminate();
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    function onAbort(): void {
      finish(() => reject(new CancellationError('Worker cancelled', { cause: signal?.reason })));
    }

    worker.on('message', (msg: { ok: boolean; value?: Awaited<T>; error?: unknown }) => {
      if (msg.ok) finish(() => resolve(msg.value as Awaited<T>));
      else finish(() => reject(msg.error));
    });
    worker.on('error', (err) => finish(() => reject(err)));
    worker.on('exit', (code) => {
      // Non-zero on our own terminate() too, but by then we've already settled.
      if (code !== 0) finish(() => reject(new Error(`Worker stopped with exit code ${code}`)));
    });

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (timeout !== undefined) {
      timer = setTimeout(
        () => finish(() => reject(new TimeoutError(`Worker timed out after ${timeout}ms`))),
        timeout,
      );
      (timer as unknown as { unref?: () => void }).unref?.();
    }
  });
}
