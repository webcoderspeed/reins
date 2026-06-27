import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sleep,
  withTimeout,
  withScope,
  TimeoutError,
  CancellationError,
  isCancellation,
} from '../src/index.js';

test('sleep resolves after the delay', async () => {
  const start = Date.now();
  await sleep(25);
  assert.ok(Date.now() - start >= 20);
});

test('sleep rejects promptly when its signal aborts', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);

  const start = Date.now();
  await assert.rejects(
    sleep(1000, controller.signal),
    (err: unknown) => isCancellation(err) || err instanceof CancellationError,
  );
  // Unwound near the abort, nowhere near the full 1000ms.
  assert.ok(Date.now() - start < 200);
});

test('sleep with an already-aborted signal rejects immediately', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sleep(1000, controller.signal));
});

test('withTimeout returns the task result when it finishes in time', async () => {
  const value = await withTimeout(async () => {
    await sleep(10);
    return 42;
  }, 100);
  assert.equal(value, 42);
});

test('withTimeout rejects with TimeoutError when the task is too slow', async () => {
  await assert.rejects(
    withTimeout((signal) => sleep(1000, signal), 20),
    (err: unknown) => err instanceof TimeoutError,
  );
});

test('withTimeout forwards the signal so the task unwinds promptly', async () => {
  let aborted = false;
  const start = Date.now();
  await assert.rejects(
    withTimeout(async (signal) => {
      try {
        await sleep(1000, signal);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }, 20),
    (err: unknown) => err instanceof TimeoutError,
  );
  assert.equal(aborted, true);
  assert.ok(Date.now() - start < 200);
});

test('a timeout that does not fire leaves a clean result', async () => {
  const result = await withScope(
    async (scope) => {
      const a = scope.spawn(async () => {
        await sleep(10, scope.signal);
        return 'a';
      });
      return a;
    },
    { timeout: 1000 },
  );
  assert.equal(result, 'a');
});
