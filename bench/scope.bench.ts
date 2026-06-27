/**
 * Overhead benchmark: how much does a scope cost over raw `Promise.all`?
 *
 * Run: `npm run bench`
 */
import { Bench } from 'tinybench';
import { withScope } from '../src/index.js';

const N = 100;
const work = (): Promise<number> => Promise.resolve(1);

const bench = new Bench({ time: 500 });

bench
  .add('raw Promise.all (baseline)', async () => {
    await Promise.all(Array.from({ length: N }, () => work()));
  })
  .add('withScope + spawn', async () => {
    await withScope(async (scope) => {
      const tasks = Array.from({ length: N }, () => scope.spawn(() => work()));
      return Promise.all(tasks);
    });
  })
  .add('withScope + spawnAll', async () => {
    await withScope((scope) => scope.spawnAll(Array.from({ length: N }, () => () => work())));
  });

await bench.run();

console.log(`\nFan-out of ${N} trivial async tasks (higher ops/sec = better):\n`);
console.table(bench.table());
