import { test } from 'node:test';
import assert from 'node:assert/strict';
import { race, sleep, TimeoutError, CancellationError, isCancellation } from '../src/index.js';

test('race resolves with the first task to succeed', async () => {
  const result = await race([
    async () => {
      await sleep(40);
      return 'slow';
    },
    async () => {
      await sleep(10);
      return 'fast';
    },
  ]);
  assert.equal(result, 'fast');
});

test('race ignores a failing task and lets a slower success win', async () => {
  const result = await race([
    async () => {
      await sleep(10);
      throw new Error('fast failure');
    },
    async () => {
      await sleep(30);
      return 'slow success';
    },
  ]);
  assert.equal(result, 'slow success');
});

test('race cancels the losers once a winner appears', async () => {
  let loserCancelled = false;
  const result = await race([
    async () => {
      await sleep(10);
      return 'winner';
    },
    async (signal) => {
      try {
        await sleep(1000, signal);
        return 'loser';
      } catch {
        loserCancelled = true;
        throw new Error('loser aborted');
      }
    },
  ]);
  assert.equal(result, 'winner');
  assert.equal(loserCancelled, true);
});

test('race rejects with AggregateError when every task fails', async () => {
  await assert.rejects(
    race([
      async () => {
        throw new Error('first');
      },
      async () => {
        await sleep(5);
        throw new Error('second');
      },
    ]),
    (err: unknown) => {
      assert.ok(err instanceof AggregateError);
      assert.equal(err.errors.length, 2);
      return true;
    },
  );
});

test('race rejects with TimeoutError when nothing wins in time', async () => {
  await assert.rejects(
    race([(signal) => sleep(1000, signal).then(() => 'never')], { timeout: 20 }),
    (err: unknown) => err instanceof TimeoutError,
  );
});

test('race rejects with CancellationError when an external signal aborts', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    race([(signal) => sleep(1000, signal).then(() => 'never')], { signal: controller.signal }),
    (err: unknown) => err instanceof CancellationError && isCancellation(err),
  );
});

test('race throws AggregateError for an empty task list', async () => {
  await assert.rejects(
    race([]),
    (err: unknown) => err instanceof AggregateError,
  );
});

test('race does not resolve until the losers have unwound (no leaks)', async () => {
  let loserSettled = false;
  const result = await race([
    async () => {
      await sleep(10);
      return 'winner';
    },
    async (signal) => {
      try {
        await sleep(500, signal);
      } finally {
        loserSettled = true;
      }
    },
  ]);
  assert.equal(result, 'winner');
  // By the time race resolves, the cancelled loser has already settled.
  assert.equal(loserSettled, true);
});

test('race supports sync task functions', async () => {
  const result = await race([() => 1, () => 2]);
  assert.ok(result === 1 || result === 2);
});
