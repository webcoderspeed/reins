import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners, setMaxListeners } from 'node:events';
import { withScope, sleep, isCancellation } from '../src/index.js';

test('sleep removes its abort listener after resolving (no leak)', async () => {
  const controller = new AbortController();
  // Run many sequential sleeps on one shared signal.
  for (let i = 0; i < 25; i++) {
    await sleep(1, controller.signal);
  }
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('concurrent sleeps on a shared signal release all listeners on settle', async () => {
  const controller = new AbortController();
  // This test intentionally fans 30 sleeps onto one user-owned signal; raise the
  // cap so Node doesn't warn (reins only lifts the cap on its own scope signals).
  setMaxListeners(0, controller.signal);
  await Promise.all(Array.from({ length: 30 }, () => sleep(2, controller.signal)));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('sleep removes its abort listener after rejecting too', async () => {
  const controller = new AbortController();
  const p = sleep(1000, controller.signal);
  controller.abort();
  await assert.rejects(p, (err: unknown) => isCancellation(err));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('scope.cancel() aborts the signal synchronously (same tick)', async () => {
  await assert.rejects(
    withScope(async (scope) => {
      assert.equal(scope.signal.aborted, false);
      scope.cancel();
      // No await in between — the abort must be observable immediately.
      assert.equal(scope.signal.aborted, true);
      assert.equal(isCancellation(scope.signal.reason), true);
    }),
    (err: unknown) => isCancellation(err),
  );
});

test('an aborted sleep never resolves later (timer is cleared)', async () => {
  const controller = new AbortController();
  let resolved = false;
  const p = sleep(20, controller.signal).then(
    () => {
      resolved = true;
    },
    () => {
      /* expected rejection */
    },
  );
  controller.abort();
  await p;
  await sleep(40); // wait past the original delay
  assert.equal(resolved, false);
});

test('withScope does not keep the event loop alive via its timeout timer', async () => {
  // If the timeout timer were not unref'd, a short scope with a long timeout
  // would still settle immediately; this mainly asserts no hang/leak.
  const result = await withScope(async () => 'ok', { timeout: 60_000 });
  assert.equal(result, 'ok');
});

test('the scope signal tolerates a wide fan-out without throwing', async () => {
  // Many tasks forwarding scope.signal to sleep — exercises the listener-cap lift.
  const out = await withScope(async (scope) => {
    const tasks = Array.from({ length: 40 }, (_, i) =>
      scope.spawn(async (signal) => {
        await sleep(1, signal);
        return i;
      }),
    );
    return Promise.all(tasks);
  });
  assert.equal(out.length, 40);
  assert.equal(out[0], 0);
});
