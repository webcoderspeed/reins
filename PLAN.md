# reins — Build Plan

> **Rein in your async.** Structured concurrency and cancellation for JavaScript & TypeScript — scoped tasks, automatic cancellation, timeouts. No DSL, no generators. Just `async/await`.

Status: **Planning → v0.1.0**
Package name: `reins` (verified available on npm, June 2026 — placeholder, trivially renameable)
License: MIT · Language: TypeScript · Runtimes: Node ≥18, Bun, Deno, browsers

---

## 1. What we're building (in one paragraph)

A tiny, zero-dependency library that gives JavaScript a **structured-concurrency primitive**: a "scope" (a.k.a. nursery) that *owns* the async tasks started inside it. When the scope exits, every task it started is guaranteed to be finished or cancelled — no orphaned promises, no leaked work, no forgotten `AbortController` plumbing. If one task fails, its siblings are cancelled and the error propagates out of the scope. If the scope times out or its parent cancels, everything inside unwinds cleanly. You write normal `async/await` the whole time.

Think: **Go's `context` + Python Trio's nurseries + Kotlin's `coroutineScope`, but native-feeling in JS.**

---

## 2. The problem (why this should exist)

JavaScript has no first-class way to manage the *lifetime* of concurrent async work. In practice this means:

- **Cancellation is hand-rolled every time.** You thread an `AbortSignal` through every function by hand, remember to check `signal.aborted`, and wire up `addEventListener("abort", …)` cleanup. Miss a spot and you leak work.
- **Orphaned tasks are a standard bug class.** Fire off `doThing()` without awaiting it and it keeps running after the function that started it has returned — racing, double-writing, throwing into the void.
- **Errors get lost.** A rejected promise you didn't await becomes an `unhandledRejection`, or silently disappears.
- **"Cancel the other requests when one fails / when the user navigates away"** is something every app needs and nobody has a clean primitive for.

### Evidence this is a real, felt pain (2025–2026)
- *"At some point, **every JavaScript developer asks the same question: why can't I just cancel this async operation?** … JavaScript does not provide task cancellation as a primitive."* — Gabor Koos, Dec 2025.
- A respected engineer surveyed the whole field and ended up **hand-rolling his own `withScope`** because nothing fit — the textbook "should exist but doesn't" signal.
- The native building blocks to do this well (`AbortSignal.any()`, `AbortSignal.timeout()`) only recently reached broad availability — so a clean library is newly practical.

---

## 3. Why existing options don't cover it (our wedge)

| Option | What it is | Why it's not the answer |
|--------|-----------|-------------------------|
| **Effect** | A full effect-system / runtime with fibers | Real structured concurrency, but you adopt a **heavy embedded DSL** and rewrite your code into it. Huge concept count. Most teams won't. |
| **Effection** | Structured concurrency via generators | Works, but **forces `function*` / `yield*`** instead of `async/await`. Different mental model. |
| **Raw `AbortController`/`AbortSignal`** | The browser/Node primitive | Gives you the *pieces* but **no scope or lifetime management** — you still manually thread signals and wait for children. A TC39 delegate's own notes say this "is explicitly not structured concurrency." |
| **`p-limit` / `p-map` / `p-queue`** | Concurrency limiters | Solve *how many at once*, not *who owns these tasks and when do they end*. Different problem. |

**Our position:** the lightweight, `async/await`-native, drop-in primitive in the gap between "raw AbortSignal" and "adopt Effect." TC39 has **no structured-concurrency proposal on the standards track**, so there's runway.

---

## 4. The API (v0.1 surface)

Deliberately tiny. Five exports.

```ts
import { withScope, sleep, withTimeout, CancellationError, TimeoutError } from "reins";
```

### `withScope(body, options?)`
The core. Runs `body(scope)`; doesn't resolve until **every** task spawned in the scope has settled or been cancelled.

```ts
const results = await withScope(async (scope) => {
  const user   = scope.spawn((signal) => fetch(`/u/${id}`,    { signal }));
  const orders = scope.spawn((signal) => fetch(`/o/${id}`,    { signal }));
  const prefs  = scope.spawn((signal) => fetch(`/p/${id}`,    { signal }));
  return Promise.all([user, orders, prefs]);
}, { timeout: 5000 });
// If any fetch fails → the other two are aborted, withScope rejects with that error.
// If 5s elapses    → all three are aborted, rejects with TimeoutError.
```

```ts
interface Scope {
  /** Aborted when the scope tears down (completion, error, timeout, or cancel). Pass to fetch/sleep/etc. */
  readonly signal: AbortSignal;
  /** Start a child task bound to this scope. Returns a promise for its result. */
  spawn<T>(task: (signal: AbortSignal) => Promise<T> | T): Promise<T>;
  /** Cancel the whole scope (and all children) now. */
  cancel(reason?: unknown): void;
}

interface WithScopeOptions {
  signal?: AbortSignal;   // external cancellation — when this aborts, the scope cancels
  timeout?: number;       // ms — cancel the whole scope after this long
  name?: string;          // label for debugging / error messages
}
```

### `sleep(ms, signal?)`
A cancellable delay. Rejects promptly if `signal` aborts (so it unwinds inside a scope).

### `withTimeout(task, ms)`
Sugar: run one task with a deadline. `withTimeout((signal) => work(signal), 1000)`.

### `CancellationError` / `TimeoutError`
Typed errors, plus an `isCancellation(err)` helper to tell "was cancelled" from "actually failed."

---

## 5. Semantics (the contract we promise)

1. **Concurrency.** Tasks spawned in a scope run concurrently.
2. **Join-on-exit.** `withScope` does not resolve until all spawned tasks have settled — even tasks the body didn't `await`. No leaks.
3. **Error → cancel siblings.** The first task (or the body) to throw becomes the cause: all other tasks are aborted, and `withScope` rejects with **that root-cause error** (not the secondary cancellation noise).
4. **Timeout.** `timeout` aborts the whole scope and rejects with `TimeoutError`.
5. **External cancellation.** If `options.signal` aborts, the scope cancels and rejects with the reason.
6. **Cooperative.** Cancellation is delivered via `AbortSignal`. Tasks that forward the signal (to `fetch`, `sleep`, DB drivers, etc.) unwind promptly. A task that ignores the signal can't be force-killed — that's a JS limitation, and we document it loudly. `withScope` still returns promptly on cancellation rather than hanging on an uncooperative body.
7. **Nestable.** Scopes nest; an outer cancel propagates into inner scopes through the signal chain.
8. **No unhandled rejections.** Ignoring a `spawn()` result never produces an `unhandledRejection`; the error surfaces through the scope instead.

---

## 6. File / repo layout

```
reins/
├── PLAN.md                 ← this file
├── README.md               ← the public pitch + quickstart + API + comparisons
├── LICENSE                 ← MIT
├── package.json            ← ESM + CJS + types, dual-published, sideEffects:false
├── tsconfig.json
├── tsup.config.ts          ← build to dist/ (esm, cjs, .d.ts)
├── .gitignore
├── src/
│   ├── index.ts            ← public exports only
│   ├── scope.ts            ← withScope + Scope (the core)
│   ├── time.ts             ← sleep, withTimeout
│   └── errors.ts           ← CancellationError, TimeoutError, isCancellation
├── test/
│   ├── scope.test.ts       ← all the semantics above
│   └── time.test.ts
└── examples/
    └── fanout.ts           ← runnable "cancel siblings on first failure" demo
```

---

## 7. Roadmap

### v0.1.0 — "it works and it's honest" (this sprint)
- `withScope`, `spawn`, `cancel`, `scope.signal`
- `sleep`, `withTimeout`
- `CancellationError`, `TimeoutError`, `isCancellation`
- Full test suite for §5 semantics
- README with quickstart + comparison table
- ESM + CJS + types, zero runtime deps

### v0.2.0 — ergonomics
- `scope.spawnAll([...])` / structured `race` and `all` helpers that respect the scope
- `retry(task, { attempts, backoff, signal })`
- `deadline` / `Clock` abstraction so timeouts are testable without real timers
- Optional `AbortSignal.any`-based fast path where available

### v1.0.0 — production
- Error aggregation mode (`AggregateError` when multiple tasks fail concurrently)
- Benchmarks vs. raw `Promise.all` (prove overhead is negligible)
- Docs site + recipes (React effects, request cancellation, fan-out/fan-in, worker pools)
- 100% coverage, CI matrix (Node/Bun/Deno), `tsd` type tests

---

## 8. Testing strategy

Vitest. One test per semantic in §5, each fast (fake-ish timing via short real delays for v0.1; a `Clock` injection lands in v0.2 to make them instant and deterministic). Cases:
- all children resolve → body result returned
- body returns before a child finishes → scope still waits for the child
- one child throws → siblings cancelled, scope rejects with the child's error
- `timeout` elapses → children cancelled, rejects `TimeoutError`
- external `signal` aborts → rejects `CancellationError`
- body throws → children cancelled
- nested scopes propagate cancellation
- `scope.cancel()` tears everything down
- `sleep` resolves; `sleep` rejects promptly on abort
- ignoring a `spawn()` result never triggers `unhandledRejection`

---

## 9. Distribution / adoption plan (so it actually gets used)

From the OSS-traction research, solo wins come from a **small, sharp primitive with a visceral first-run "wait, that's it?" moment** + deliberate distribution:

1. **Killer README first line + a 6-line code sample** that shows "one fails → the rest auto-cancel." That's the demo.
2. **A 60-second animated/asciinema clip** of the fan-out-cancel example.
3. **Launch posts**: a "Show HN", an r/javascript + r/node post, and an X thread framed as *"JS finally gets Trio-style nurseries — cancel-on-failure in 6 lines, zero deps."*
4. **SEO via keywords**: `structured-concurrency`, `cancellation`, `abortcontroller`, `nursery` — so people searching the pain find it.
5. **Recipes** for the three most-searched cases: cancel-on-navigate (React), cancel-other-requests-on-first-error, and bounded fan-out.
6. **Honesty about cooperative cancellation** up front — builds trust, preempts the #1 "gotcha" issue.

---

## 10. Open decisions (let's lock these)

- **Name:** `reins` (available, brandable, great tagline) vs. a descriptive `structured-concurrency` / scoped `@speedsharma/nursery`. → *Proposed: ship as `reins`, keep keywords for discoverability.*
- **`spawn()` return:** returns a promise for the result (current plan) vs. a richer `Task` handle (`.result`, `.cancel()`). → *v0.1 = plain promise; revisit Task handle in v0.2.*
- **Multi-error policy:** v0.1 throws the **root-cause** error only (predictable); `AggregateError` mode is a v1.0 opt-in. → *Agreed unless you want aggregation sooner.*
- **Minimum Node:** 18 (covers `AbortController`/`AbortSignal`; we avoid `AbortSignal.any` in core for max compat). → *Proposed.*

---

## 11. Definition of done for v0.1.0
- `npm install && npm run build && npm test` → green
- `dist/` ships ESM + CJS + `.d.ts`
- README renders the pitch + quickstart + comparison + the cooperative-cancellation caveat
- Zero runtime dependencies
- Published-ready (`npm publish --dry-run` clean)
