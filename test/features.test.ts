import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withScope,
  createScope,
  retry,
  sleep,
  CancellationError,
  TimeoutError,
  isCancellation,
} from '../src/index.js';

// ─────────────────────────────── concurrency ───────────────────────────────

test('concurrency: never runs more than the limit at once', async () => {
  let active = 0;
  let peak = 0;
  await withScope(
    async (scope) => {
      const tasks = Array.from({ length: 10 }, () =>
        scope.spawn(async () => {
          active++;
          peak = Math.max(peak, active);
          await sleep(10);
          active--;
        }),
      );
      await Promise.all(tasks);
    },
    { concurrency: 3 },
  );
  assert.equal(peak, 3);
});

test('concurrency: all queued tasks still run and return results in order', async () => {
  const results = await withScope(
    async (scope) => scope.spawnAll(Array.from({ length: 8 }, (_, i) => async () => {
      await sleep(5);
      return i * 2;
    })),
    { concurrency: 2 },
  );
  assert.deepEqual(results, [0, 2, 4, 6, 8, 10, 12, 14]);
});

test('concurrency: aborting the scope rejects still-queued tasks without running them', async () => {
  let started = 0;
  await assert.rejects(
    withScope(
      async (scope) => {
        const tasks = Array.from({ length: 6 }, () =>
          scope.spawn(async (signal) => {
            started++;
            await sleep(1000, signal);
          }),
        );
        await sleep(10);
        scope.cancel();
        await Promise.all(tasks);
      },
      { concurrency: 2 },
    ),
    (err: unknown) => isCancellation(err),
  );
  // Only the first 2 (the concurrency window) ever started.
  assert.equal(started, 2);
});

// ──────────────────────────────── spawnAll ─────────────────────────────────

test('spawnAll returns results in order', async () => {
  const out = await withScope((scope) =>
    scope.spawnAll([async () => 'a', async () => 'b', async () => 'c']),
  );
  assert.deepEqual(out, ['a', 'b', 'c']);
});

test('spawnAll: one task fails → siblings cancelled, scope rejects with that error', async () => {
  const boom = new Error('boom');
  let siblingAborted = false;
  await assert.rejects(
    withScope((scope) =>
      scope.spawnAll([
        async () => {
          await sleep(10);
          throw boom;
        },
        async (signal) => {
          try {
            await sleep(1000, signal);
          } catch {
            siblingAborted = true;
            throw new Error('sibling aborted');
          }
        },
      ]),
    ),
    (err: unknown) => err === boom,
  );
  assert.equal(siblingAborted, true);
});

// ───────────────────────────────── retry ───────────────────────────────────

test('retry: returns immediately on success (no retries)', async () => {
  let calls = 0;
  const value = await retry(async () => {
    calls++;
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(calls, 1);
});

test('retry: retries on failure then succeeds', async () => {
  let calls = 0;
  const value = await retry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    },
    { attempts: 5, delay: 1 },
  );
  assert.equal(value, 'ok');
  assert.equal(calls, 3);
});

test('retry: throws the last error after exhausting attempts', async () => {
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls++;
        throw new Error(`fail ${calls}`);
      },
      { attempts: 3, delay: 1 },
    ),
    (err: unknown) => err instanceof Error && err.message === 'fail 3',
  );
  assert.equal(calls, 3);
});

test('retry: does not retry a cancellation', async () => {
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls++;
        throw new CancellationError('nope');
      },
      { attempts: 5, delay: 1 },
    ),
    (err: unknown) => err instanceof CancellationError,
  );
  assert.equal(calls, 1);
});

test('retry: an aborting signal stops retrying promptly', async () => {
  const controller = new AbortController();
  let calls = 0;
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(
    retry(
      async () => {
        calls++;
        throw new Error('keep failing');
      },
      { attempts: 100, delay: 20, signal: controller.signal },
    ),
  );
  // With a 20ms backoff and abort at 15ms, only a couple of attempts happen.
  assert.ok(calls < 5, `expected few attempts, got ${calls}`);
});

test('retry: composes inside a scope (scope cancel stops the retry loop)', async () => {
  await assert.rejects(
    withScope(
      async (scope) =>
        retry((s) => sleep(1000, s).then(() => 'never'), {
          attempts: 10,
          delay: 5,
          signal: scope.signal,
        }),
      { timeout: 20 },
    ),
    (err: unknown) => err instanceof TimeoutError,
  );
});

// ──────────────────────── createScope / await using ────────────────────────

test('createScope: explicit dispose joins spawned tasks', async () => {
  let done = false;
  const scope = createScope();
  try {
    scope.spawn(async () => {
      await sleep(20);
      done = true;
    });
  } finally {
    await scope.dispose();
  }
  assert.equal(done, true);
});

test('await using: scope tears down at block end (children cancelled & joined)', async () => {
  let aborted = false;
  await (async () => {
    await using scope = createScope();
    scope.spawn(async (signal) => {
      try {
        await sleep(1000, signal);
      } catch {
        aborted = true;
      }
    });
    await sleep(10);
    // leaving this block disposes the scope → child is cancelled and joined
  })();
  assert.equal(aborted, true);
});

test('await using: a real task failure surfaces at dispose', async () => {
  await assert.rejects(
    (async () => {
      await using scope = createScope();
      scope.spawn(async () => {
        await sleep(10);
        throw new Error('task blew up');
      });
      await sleep(30); // let it fail before the block ends
    })(),
    (err: unknown) => err instanceof Error && err.message === 'task blew up',
  );
});

test('createScope: dispose swallows cancellation but is idempotent', async () => {
  const scope = createScope();
  scope.spawn(async (signal) => {
    try {
      await sleep(1000, signal);
    } catch {
      /* expected */
    }
  });
  await sleep(5);
  scope.cancel();
  // Cancellation is expected control flow → dispose must NOT throw.
  await scope.dispose();
  await scope.dispose(); // idempotent — no throw, no double-teardown
  assert.ok(scope.signal.aborted);
});

test('createScope: respects concurrency too', async () => {
  let active = 0;
  let peak = 0;
  const scope = createScope({ concurrency: 2 });
  try {
    const tasks = Array.from({ length: 6 }, () =>
      scope.spawn(async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(5);
        active--;
      }),
    );
    await Promise.all(tasks);
  } finally {
    await scope.dispose();
  }
  assert.equal(peak, 2);
});
