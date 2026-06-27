import { expectType, expectError, expectAssignable } from 'tsd';
import { withScope, createScope, retry, race, sleep, withTimeout, isCancellation } from '../dist/index.js';
import type { WithScopeOptions } from '../dist/index.js';
import { runInWorker } from '../dist/worker.js';

// withScope infers the body's return type.
expectType<Promise<number>>(withScope(async () => 1));
expectType<Promise<string>>(withScope(() => 'sync-ok'));

// Inside the body, spawn/spawnAll/signal are correctly typed.
withScope((scope) => {
  expectType<AbortSignal>(scope.signal);
  expectType<Promise<number>>(scope.spawn(async () => 1));
  expectType<Promise<string[]>>(scope.spawnAll([async () => 'a', () => 'b']));
  return 0;
});

// Options are typed; bad option types are rejected.
expectType<Promise<void>>(
  withScope(async () => {}, { concurrency: 4, timeout: 100, name: 'x' } satisfies WithScopeOptions),
);
expectError(withScope(async () => {}, { concurrency: 'lots' }));
expectError(withScope(async () => {}, { timeout: '5s' }));

// createScope returns a disposable handle with an explicit dispose().
expectAssignable<AsyncDisposable>(createScope());
expectType<Promise<void>>(createScope().dispose());

// retry infers the task result; bad options are rejected.
expectType<Promise<number>>(retry(async () => 1));
expectType<Promise<string>>(retry(() => 'x', { attempts: 5, delay: 10, jitter: true }));
expectError(retry(async () => 1, { attempts: 'three' }));

// race infers the common task result type
expectType<Promise<number>>(race([async () => 1, () => 2]));
expectType<Promise<string>>(race([() => 'a'], { timeout: 100 }));
expectError(race([() => 1], { timeout: '5s' }));

// helpers
expectType<Promise<void>>(sleep(10));
expectType<Promise<number>>(withTimeout(async () => 1, 100));
expectType<boolean>(isCancellation(new Error()));

// worker subpath
expectType<Promise<number>>(runInWorker((n: number) => n, 5));
expectType<Promise<string>>(runInWorker(async (s: string) => s, 'hi', { timeout: 100 }));
