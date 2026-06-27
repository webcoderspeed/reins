# reinsjs

> **Rein in your async.** Structured concurrency and cancellation for JavaScript & TypeScript — scoped tasks, automatic cancellation, timeouts. No DSL, no generators. Just `async`/`await`.

[![CI](https://github.com/webcoderspeed/reins/actions/workflows/ci.yml/badge.svg)](https://github.com/webcoderspeed/reins/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/reinsjs.svg)](https://www.npmjs.com/package/reinsjs)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)

When one task fails, the rest auto-cancel. No `AbortController` plumbing. Six lines:

```ts
import { withScope } from "reinsjs";

const [user, orders, prefs] = await withScope(async (scope) => {
  const user   = scope.spawn((signal) => fetch(`/u/${id}`, { signal }).then(r => r.json()));
  const orders = scope.spawn((signal) => fetch(`/o/${id}`, { signal }).then(r => r.json()));
  const prefs  = scope.spawn((signal) => fetch(`/p/${id}`, { signal }).then(r => r.json()));
  return Promise.all([user, orders, prefs]);
}, { timeout: 5000 });
// Any fetch fails → the other two are aborted, withScope rejects with that error.
// 5s elapses       → all three are aborted, rejects with TimeoutError.
// Nothing leaks. You never touched an AbortController.
```

---

## Why

JavaScript has no first-class way to manage the **lifetime** of concurrent async work:

- **Cancellation is hand-rolled every time** — thread an `AbortSignal` through every call, remember to check `signal.aborted`, wire up the `abort` listener cleanup. Miss a spot, leak work.
- **Orphaned tasks are a standard bug class** — fire off `doThing()` without awaiting and it keeps running after its caller returned: racing, double-writing, throwing into the void.
- **Errors get lost** — an unawaited rejection becomes an `unhandledRejection`, or silently vanishes.

`reinsjs` gives you a **scope** (a.k.a. a nursery) that *owns* the tasks started inside it. When the scope exits, every task it started is guaranteed finished or cancelled. Think **Go's `context` + Python Trio's nurseries + Kotlin's `coroutineScope`**, but native-feeling in JS.

## Install

```bash
npm install reinsjs
```

Zero runtime dependencies. ESM + CJS + types. **~1.2 kB** brotlied (tree-shaken `withScope`). CI-tested on **Node 18/20/22, Bun, and Deno**; works in browsers.

## The API

```ts
import {
  withScope, createScope,           // scopes
  sleep, withTimeout, retry,        // helpers
  CancellationError, TimeoutError, isCancellation, // errors
} from "reinsjs";
```

### `withScope(body, options?)`

The core. Runs `body(scope)` and **does not resolve until every task spawned in the scope has settled or been cancelled** — even tasks the body never awaited.

```ts
interface Scope {
  /** Aborted when the scope tears down. Pass to fetch/sleep/DB drivers. */
  readonly signal: AbortSignal;
  /** Start a child task bound to this scope. Returns a promise for its result. */
  spawn<T>(task: (signal: AbortSignal) => Promise<T> | T): Promise<T>;
  /** Spawn several at once and await all results, in order. */
  spawnAll<T>(tasks: Iterable<(signal: AbortSignal) => Promise<T> | T>): Promise<T[]>;
  /** Cancel the whole scope (and all children) now. */
  cancel(reason?: unknown): void;
}

interface WithScopeOptions {
  signal?: AbortSignal;   // external cancellation — when this aborts, the scope cancels
  timeout?: number;       // ms — cancel the whole scope after this long
  name?: string;          // label for debugging / error messages
  concurrency?: number;   // max tasks running at once; extra spawns queue
}
```

**Bounded fan-out** — cap how many run at once without losing the scope guarantees:

```ts
// Crawl 1000 URLs, 8 at a time; if any fails, the rest are cancelled.
const pages = await withScope(
  (scope) => scope.spawnAll(urls.map((u) => (signal) => fetch(u, { signal }))),
  { concurrency: 8 },
);
```

### `createScope(options?)` — `await using`

A scope you manage yourself, for [explicit resource management](https://github.com/tc39/proposal-explicit-resource-management). Spawn into it; when the block exits, it cancels unfinished children, waits for them to unwind, and re-throws the first real failure.

```ts
await using scope = createScope({ timeout: 5000 });
const user = scope.spawn((s) => fetch(`/u/${id}`, { signal: s }));
const data = await user;
// ← block end: scope tears down. Nothing leaks, even on throw.
```

On runtimes without `await using` (Node < 24 with no polyfill), use the explicit form — same guarantees:

```ts
const scope = createScope();
try {
  await scope.spawn(work);
} finally {
  await scope.dispose();
}
```

### `sleep(ms, signal?)`

A cancellable delay. Rejects promptly if `signal` aborts, so it unwinds cleanly inside a scope.

```ts
await withScope(async (scope) => {
  await sleep(1000, scope.signal); // rejects immediately if the scope cancels
});
```

### `withTimeout(task, ms)`

Sugar for one task with a deadline.

```ts
const data = await withTimeout((signal) => fetch(url, { signal }), 1000);
```

### `retry(task, options?)`

Run a task, retrying on failure with exponential backoff. **Cancellations are never retried** (a `CancellationError`/`AbortError` or an aborted `signal` stops it immediately), and the backoff delay is cancellable — so a retry loop unwinds promptly inside a scope.

```ts
const data = await withScope((scope) =>
  retry((s) => fetch(url, { signal: s }).then((r) => r.json()), {
    attempts: 5,      // total tries (default 3)
    delay: 200,       // base ms (default 100)
    factor: 2,        // backoff multiplier (default 2)
    maxDelay: 5000,   // cap (default ∞)
    jitter: true,     // randomize delay (default false)
    signal: scope.signal,
  }),
);
```

### `CancellationError` / `TimeoutError` / `isCancellation(err)`

Typed errors, plus a helper to tell "was cancelled" from "actually failed":

```ts
try {
  await withScope(/* … */);
} catch (err) {
  if (isCancellation(err)) return; // expected: user navigated away, etc.
  throw err;                       // a real failure
}
```

## Semantics (the contract)

1. **Concurrency.** Tasks spawned in a scope run concurrently.
2. **Join-on-exit.** `withScope` doesn't resolve until all spawned tasks settle — even ones the body didn't `await`. No leaks.
3. **Error → cancel siblings.** The first task (or the body) to throw becomes the cause: every other task is aborted, and `withScope` rejects with **that root-cause error** — not the secondary cancellation noise.
4. **Timeout.** `timeout` aborts the whole scope and rejects with `TimeoutError`.
5. **External cancellation.** If `options.signal` aborts, the scope cancels and rejects with a `CancellationError` carrying the original reason as `.cause`.
6. **Cooperative.** Cancellation is delivered via `AbortSignal`. Tasks that forward the signal unwind promptly (see caveat below).
7. **Nestable.** Scopes nest; pass `outer.signal` to an inner `withScope` and an outer cancel propagates inward.
8. **No unhandled rejections.** Ignoring a `spawn()` result never produces an `unhandledRejection` — the error surfaces through the scope instead.

## ⚠️ Cooperative cancellation (read this)

JavaScript **cannot forcibly kill a running async function** — there are no green threads to interrupt. `reinsjs` cancels by aborting an `AbortSignal`. A task unwinds promptly **only if it forwards that signal** to the things it awaits (`fetch`, `sleep`, DB drivers, child scopes) or checks `signal.aborted` itself.

```ts
// ✅ Cancels promptly — forwards the signal
scope.spawn((signal) => fetch(url, { signal }));
scope.spawn((signal) => sleep(1000, signal));

// ❌ Cannot be cancelled — ignores the signal, runs to completion
scope.spawn(() => fetch(url));        // no signal passed
scope.spawn(() => heavyCpuLoop());    // never yields, never checks
```

Because of join-on-exit, an uncooperative task **delays** the scope's teardown until it finishes on its own. This is a JavaScript limitation, not a `reinsjs` bug — we surface it loudly so there are no surprises.

### The escape hatch: `reinsjs/worker` (experimental)

For the one case cooperative cancellation *can't* handle — a CPU-bound task that never checks the signal — there's a genuinely preemptive option: run it in a worker thread and `terminate()` it.

```ts
import { runInWorker } from "reinsjs/worker";

// This loop never checks any signal. It is still killed at 500ms.
await runInWorker((n) => { while (true) heavyCompute(n); }, 1_000_000, { timeout: 500 });
// → rejects with TimeoutError, and the thread is actually terminated.
```

The trade-off is the worker boundary: the task runs in a fresh thread, so it **can't close over outer variables**, and its `input`/result must be structured-cloneable — pass everything it needs via `input`. Node-only for now (`node:worker_threads`); browser/Deno support is on the roadmap. This is the only way to get true preemption in JS — see [docs/cancellation-rfc.md](./docs/cancellation-rfc.md) for the full analysis and where the language could go next.

## Recipes

**Cancel other requests when the first one fails** — that's the quickstart above.

**Cancel on navigate (React):**

```ts
useEffect(() => {
  const controller = new AbortController();
  withScope(async (scope) => {
    const data = await scope.spawn((s) => fetch(url, { signal: s }).then(r => r.json()));
    setState(data);
  }, { signal: controller.signal }).catch((err) => {
    if (!isCancellation(err)) throw err;
  });
  return () => controller.abort(); // unmount → everything in the scope aborts
}, [url]);
```

**Race: first one to finish wins, the rest get cancelled:**

```ts
const winner = await withScope(async (scope) => {
  return Promise.race([
    scope.spawn((s) => fetchFrom(mirrorA, s)),
    scope.spawn((s) => fetchFrom(mirrorB, s)),
  ]);
}); // scope exit aborts the loser
```

There's a runnable fan-out demo in [`examples/fanout.ts`](./examples/fanout.ts):

```bash
npx tsx examples/fanout.ts          # happy path
npx tsx examples/fanout.ts --fail   # one fails → the others auto-cancel
```

## How it compares

| Option | What it is | Why reinsjs instead |
|--------|-----------|-------------------|
| **[Effect](https://effect.website)** | Full effect-system / runtime with fibers | Real structured concurrency, but you adopt a heavy embedded DSL and rewrite into it. `reinsjs` is a single primitive you drop into plain `async`/`await`. |
| **[Effection](https://frontside.com/effection)** | Structured concurrency via generators | Bulletproof teardown — but it's built on `function*` / `yield*`, a different mental model from `async`/`await`. `reinsjs` keeps you in `async`/`await` (see the honest trade-off below). |
| **raw `AbortController`** | The platform primitive | Gives you the pieces but no scope or lifetime management — you still thread signals and join children by hand. `reinsjs` *is* the missing scope. |
| **`p-limit` / `p-map` / `p-queue`** | Concurrency limiters | Solve *how many at once*. `reinsjs` does that too (`{ concurrency }`) **and** owns task lifetime + cancellation. |

`reinsjs` is the lightweight, `async`/`await`-native primitive in the gap between "raw AbortSignal" and "adopt Effect."

### Honest trade-off vs. Effection

Effection drives **generators**, so it can inject teardown at every `yield` point and *guarantee* `finally` blocks run even on abort. `reinsjs` uses plain `async`/`await` + cooperative `AbortSignal`, which is why a task that ignores the signal can't be force-unwound (see the caveat above; the `reinsjs/worker` escape hatch covers the CPU-bound case). The deal: **`reinsjs` trades Effection's strongest teardown guarantee for zero new syntax and a ~1 kB footprint.** If you want airtight teardown and don't mind `yield*`, use Effection. If you want structured concurrency that disappears into the `async`/`await` you already write, use `reinsjs`.

## Performance

Overhead is **~250 ns per spawned task** over a raw `Promise.all` (run `npm run bench`). That's negligible next to any real async work (a network call or disk read is ~10,000× that), though measurable if you're fanning out thousands of near-empty promises in a hot loop. The structured guarantees — join-on-exit, cancel-on-error, no leaks — are what that buys you.

## License

MIT © [webcoderspeed](https://github.com/webcoderspeed)
