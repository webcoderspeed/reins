import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInWorker } from '../src/worker.js';
import { CancellationError, TimeoutError, isCancellation } from '../src/index.js';

test('runInWorker runs a self-contained task and returns its result', async () => {
  const result = await runInWorker((n: number) => n * 2, 21);
  assert.equal(result, 42);
});

test('runInWorker supports async tasks', async () => {
  const result = await runInWorker(async (s: string) => {
    return s.toUpperCase();
  }, 'hi');
  assert.equal(result, 'HI');
});

test('runInWorker propagates an error thrown by the task', async () => {
  await assert.rejects(
    runInWorker(() => {
      throw new Error('worker task failed');
    }),
    (err: unknown) => err instanceof Error && err.message === 'worker task failed',
  );
});

test('runInWorker TIMEOUT kills a CPU-bound infinite loop (real preemption)', async () => {
  const start = Date.now();
  await assert.rejects(
    // This loop never checks any signal — cooperative cancellation could not stop it.
    runInWorker(() => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        /* burn CPU forever */
      }
    }, undefined, { timeout: 150 }),
    (err: unknown) => err instanceof TimeoutError,
  );
  // It actually terminated rather than hanging the test.
  assert.ok(Date.now() - start < 2000);
});

test('runInWorker signal abort terminates the worker', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(
    runInWorker(() => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        /* ignore the world */
      }
    }, undefined, { signal: controller.signal }),
    (err: unknown) => err instanceof CancellationError && isCancellation(err),
  );
});

test('runInWorker rejects immediately on an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runInWorker((n: number) => n, 1, { signal: controller.signal }),
    (err: unknown) => err instanceof CancellationError,
  );
});
