// Cross-runtime smoke test: import the BUILT package and exercise the core.
// Runs under Node, Bun, and Deno in CI to prove the published bundle loads and
// works on each. A thrown error exits non-zero on every runtime.
import { withScope, sleep, retry, createScope, isCancellation } from '../dist/index.js';

// 1) basic fan-out + join
const result = await withScope(async (scope) => {
  const a = scope.spawn(async () => {
    await sleep(5);
    return 1;
  });
  const b = scope.spawn(async () => 2);
  return Promise.all([a, b]);
});
if (result[0] !== 1 || result[1] !== 2) {
  throw new Error(`fan-out failed: ${JSON.stringify(result)}`);
}

// 2) error cancels siblings; scope rejects with the root cause
let cancelledOk = false;
try {
  await withScope((scope) =>
    scope.spawnAll([
      async () => {
        await sleep(2);
        throw new Error('boom');
      },
      async (signal) => {
        try {
          await sleep(1000, signal);
        } catch {
          cancelledOk = true;
        }
      },
    ]),
  );
  throw new Error('expected the scope to reject');
} catch (err) {
  if (!(err instanceof Error) || err.message !== 'boom') throw err;
}
if (!cancelledOk) throw new Error('sibling was not cancelled');

// 3) retry returns after a transient failure
let tries = 0;
const retried = await retry(
  async () => {
    tries++;
    if (tries < 2) throw new Error('transient');
    return 'ok';
  },
  { attempts: 3, delay: 1 },
);
if (retried !== 'ok') throw new Error('retry failed');

// 4) createScope explicit dispose
const scope = createScope();
let disposedWork = false;
scope.spawn(async () => {
  await sleep(2);
  disposedWork = true;
});
await scope.dispose();
if (!disposedWork) throw new Error('createScope did not join its task');

// 5) isCancellation sanity
if (isCancellation(new Error('nope'))) throw new Error('isCancellation false positive');

console.log('smoke OK:', JSON.stringify(result));
