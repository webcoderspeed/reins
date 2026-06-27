/**
 * Fan-out / cancel-on-first-failure demo.
 *
 * Run it:
 *   npx tsx examples/fanout.ts          # happy path — all three "fetches" succeed
 *   npx tsx examples/fanout.ts --fail   # one fails → the other two auto-cancel
 *
 * The whole point: you never wire up an AbortController by hand. When one task
 * throws, `withScope` aborts its siblings for you and rejects with the root cause.
 */
import { withScope, sleep, isCancellation } from '../src/index.js';

/** A fake API call that respects cancellation and optionally blows up. */
async function fakeFetch(
  label: string,
  ms: number,
  signal: AbortSignal,
  shouldFail = false,
): Promise<string> {
  try {
    await sleep(ms, signal);
  } catch (err) {
    if (isCancellation(err)) {
      console.log(`  ✗ ${label} cancelled mid-flight`);
    }
    throw err;
  }
  if (shouldFail) {
    console.log(`  💥 ${label} failed`);
    throw new Error(`${label} exploded`);
  }
  console.log(`  ✓ ${label} done (${ms}ms)`);
  return `${label}-result`;
}

async function main(): Promise<void> {
  const failMode = process.argv.includes('--fail');
  console.log(failMode ? 'Mode: one task fails →\n' : 'Mode: happy path →\n');

  try {
    const results = await withScope(
      async (scope) => {
        const user = scope.spawn((signal) => fakeFetch('user', 60, signal));
        // In --fail mode the *fast* task throws, so you can watch the slow ones cancel.
        const orders = scope.spawn((signal) => fakeFetch('orders', 20, signal, failMode));
        const prefs = scope.spawn((signal) => fakeFetch('prefs', 80, signal));
        return Promise.all([user, orders, prefs]);
      },
      { timeout: 5000 },
    );

    console.log('\nAll results:', results);
  } catch (err) {
    console.log(`\nScope rejected with: ${(err as Error).message}`);
    console.log('(notice the other tasks were cancelled automatically — no manual AbortController)');
    process.exitCode = 1;
  }
}

void main();
