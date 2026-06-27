import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withScope,
  sleep,
  CancellationError,
  TimeoutError,
  isCancellation,
} from '../src/index.js';

/** A deferred that lets a test settle a task on demand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('concurrency: spawned tasks run concurrently', async () => {
  const order: string[] = [];
  await withScope(async (scope) => {
    const a = scope.spawn(async () => {
      await sleep(30);
      order.push('a');
    });
    const b = scope.spawn(async () => {
      await sleep(10);
      order.push('b');
    });
    await Promise.all([a, b]);
  });
  // b (shorter) finishes before a → they really ran in parallel.
  assert.deepEqual(order, ['b', 'a']);
});

test('all children resolve → body result is returned', async () => {
  const result = await withScope(async (scope) => {
    const x = scope.spawn(async () => 1);
    const y = scope.spawn(async () => 2);
    const [a, b] = await Promise.all([x, y]);
    return a + b;
  });
  assert.equal(result, 3);
});

test('join-on-exit: body returns before a child finishes → scope still waits', async () => {
  let childDone = false;
  await withScope(async (scope) => {
    // Spawned but deliberately NOT awaited by the body.
    scope.spawn(async () => {
      await sleep(30);
      childDone = true;
    });
    return 'body-done';
  });
  assert.equal(childDone, true);
});

test('error → siblings cancelled, scope rejects with the root cause', async () => {
  let siblingAborted = false;
  const boom = new Error('boom');

  await assert.rejects(
    withScope(async (scope) => {
      const failing = scope.spawn(async () => {
        await sleep(10);
        throw boom;
      });
      const sibling = scope.spawn(async (signal) => {
        try {
          await sleep(1000, signal);
        } catch {
          siblingAborted = true;
          throw new Error('sibling aborted');
        }
      });
      await Promise.all([failing, sibling]);
    }),
    (err: unknown) => err === boom, // root cause, not the secondary cancellation noise
  );

  assert.equal(siblingAborted, true);
});

test('timeout → children cancelled, rejects with TimeoutError', async () => {
  let aborted = false;
  await assert.rejects(
    withScope(
      async (scope) => {
        await scope.spawn(async (signal) => {
          try {
            await sleep(1000, signal);
          } catch (err) {
            aborted = true;
            throw err;
          }
        });
      },
      { timeout: 20 },
    ),
    (err: unknown) => err instanceof TimeoutError,
  );
  assert.equal(aborted, true);
});

test('external signal aborts → rejects with CancellationError', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('navigated away')), 20);

  await assert.rejects(
    withScope(
      async (scope) => {
        await sleep(1000, scope.signal);
      },
      { signal: controller.signal },
    ),
    (err: unknown) => err instanceof CancellationError && isCancellation(err),
  );
});

test('already-aborted external signal → rejects immediately', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    withScope(async (scope) => {
      await sleep(1000, scope.signal);
    }, { signal: controller.signal }),
    (err: unknown) => err instanceof CancellationError,
  );
});

test('body throws → children are cancelled', async () => {
  let aborted = false;
  await assert.rejects(
    withScope(async (scope) => {
      scope.spawn(async (signal) => {
        try {
          await sleep(1000, signal);
        } catch {
          aborted = true;
        }
      });
      await sleep(10);
      throw new Error('body failed');
    }),
    (err: unknown) => err instanceof Error && err.message === 'body failed',
  );
  assert.equal(aborted, true);
});

test('nested scopes: outer cancel propagates into inner scope', async () => {
  let innerAborted = false;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(
    withScope(
      async (outer) => {
        await withScope(
          async (inner) => {
            try {
              await sleep(1000, inner.signal);
            } catch {
              innerAborted = true;
              throw new CancellationError('inner cancelled');
            }
          },
          { signal: outer.signal }, // chain the signal inward
        );
      },
      { signal: controller.signal },
    ),
    (err: unknown) => err instanceof CancellationError,
  );
  assert.equal(innerAborted, true);
});

test('scope.cancel() tears everything down', async () => {
  let aborted = false;
  await assert.rejects(
    withScope(async (scope) => {
      scope.spawn(async (signal) => {
        try {
          await sleep(1000, signal);
        } catch {
          aborted = true;
        }
      });
      await sleep(10);
      scope.cancel();
      // give the spawned task a tick to observe the abort
      await sleep(10);
    }),
    (err: unknown) => err instanceof CancellationError,
  );
  assert.equal(aborted, true);
});

test('ignoring a spawn() result never triggers unhandledRejection', async () => {
  const rejections: unknown[] = [];
  const onRejection = (err: unknown) => rejections.push(err);
  process.on('unhandledRejection', onRejection);

  try {
    await assert.rejects(
      withScope(async (scope) => {
        // Result intentionally ignored — the error must surface via the scope,
        // not as a floating unhandledRejection.
        scope.spawn(async () => {
          await sleep(5);
          throw new Error('ignored-but-tracked');
        });
        await sleep(30);
      }),
      (err: unknown) => err instanceof Error && err.message === 'ignored-but-tracked',
    );
    // Let any stray microtask/unhandled rejection flush.
    await sleep(20);
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('spawn after the scope is aborted throws a cancellation', async () => {
  await assert.rejects(
    withScope(async (scope) => {
      scope.cancel();
      await scope.spawn(async () => 'should not run');
    }),
    (err: unknown) => err instanceof CancellationError,
  );
});

test('child can spawn grandchildren and the scope joins them all', async () => {
  let grandchildDone = false;
  await withScope(async (scope) => {
    scope.spawn(async () => {
      scope.spawn(async () => {
        await sleep(20);
        grandchildDone = true;
      });
    });
    return 'ok';
  });
  assert.equal(grandchildDone, true);
});
