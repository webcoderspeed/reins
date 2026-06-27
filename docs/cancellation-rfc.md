# Toward ergonomic cancellation & structured concurrency for `async`/`await`

> A discussion write-up from the [reinsjs](https://github.com/webcoderspeed/reins) project.
> **Status:** informal · **Author:** webcoderspeed · **Intended venue:** the
> [AsyncContext](https://github.com/tc39/proposal-async-context) thread and
> [bakkot/structured-concurrency-for-js](https://github.com/bakkot/structured-concurrency-for-js),
> *not* a new standalone proposal (see §7).

## 1. Abstract

JavaScript has no first-class way to manage the **lifetime** of concurrent async
work. Cancellation is hand-threaded through every call as an `AbortSignal`;
orphaned promises are a standard bug class; and there is no language-level
"scope" that owns the tasks started within it. This document states the problem
precisely, surveys prior art (including userland libraries that already
implement the pattern), explains **why preemptive cancellation is not the
answer**, and proposes that the ecosystem's energy go toward three tractable,
already-live directions rather than reviving the withdrawn cancellation
proposals.

## 2. The problem

Two distinct pains, often conflated:

### 2a. Cancellation is manual and viral
To make an operation cancellable today you must:
1. accept an `AbortSignal` parameter,
2. forward it to every async call you make,
3. remember to `addEventListener('abort', …)` / check `signal.aborted`, and
4. clean those listeners up.

Miss any step and you leak work or hang. The signal is **viral**: it has to be
plumbed through every layer by hand, polluting signatures that otherwise have
nothing to do with cancellation.

### 2b. There is no task lifetime / "scope"
```js
async function handler() {
  doThing();          // not awaited → keeps running after handler() returns
  return respond();
}
```
`doThing()` is now orphaned: racing, double-writing, throwing into the void as
an `unhandledRejection`. Nothing ties its lifetime to `handler()`. There is no
construct that says *"these tasks belong to this block; when the block exits,
they're all done or all cancelled."*

## 3. Why **not** preemptive cancellation

The most-requested fantasy is "just kill the async function." This cannot be
added to JS without breaking a load-bearing invariant: **run-to-completion**.
Code between two `await` points runs atomically; the entire ecosystem assumes no
other code (and no injected exception) can interleave there. Injecting a throw at
an arbitrary point would make every non-`try/finally` invariant unsound.

This is not a JS deficiency — it is near-universal:

| Runtime | Cancel a running task? |
| --- | --- |
| Go | Cooperative: check `ctx.Done()`. A tight loop ignoring it never stops. |
| Kotlin coroutines | Cooperative: `CancellationException` only at suspension points. |
| Python `trio`/`asyncio` | Cooperative: `Cancelled` injected **only at `await`**. |
| Java | `Thread.stop()` was removed as unsafe; `interrupt()` is cooperative. |
| Erlang | Truly preemptible — *because* processes share no memory. |

The lesson: true preemption requires **memory isolation** (Erlang processes,
or — in JS — Workers) or **interpreter-level injection at suspension points**
(Python). For shared-heap `async`/`await`, cooperative cancellation via a
signal is the correct and only safe model. The realistic preemptive escape
hatch in JS is `Worker.terminate()`, which reinsjs ships as an opt-in
(`reinsjs/worker`) for serializable CPU-bound work.

**So: stop trying to cancel the function. Make cooperative cancellation
ergonomic, and give tasks a lifetime.**

## 4. Prior art

- **reinsjs** — a ~1.2 kB zero-dep `withScope(body, { signal, timeout, concurrency })`
  primitive: spawn tasks into a scope; on exit every task is settled or
  cancelled; first error cancels siblings; supports `await using` via
  `Symbol.asyncDispose`. Stays in plain `async`/`await`.
- **Effection** — full structured concurrency, but via generators (`yield*`),
  which buys bulletproof teardown at the cost of leaving `async`/`await`.
- **Trio (Python)** — the canonical model: *nurseries* (scopes) + cancel scopes
  (`move_on_after`, `fail_after`). The design reinsjs and others borrow from.
- **Kotlin** — `coroutineScope` / `supervisorScope`; structured concurrency is
  the default, enforced by the compiler.
- **Go** — `context.Context` for cancellation + `errgroup` for fan-out/fan-in.
- **Swift** — `TaskGroup` / `async let`, structured concurrency in the language.

The pattern is proven across every major ecosystem. JS is the outlier in having
**no** standard form of it.

## 5. What's missing in JS, concretely

1. **Ambient cancellation** — a way for an `AbortSignal` to flow implicitly
   through an async call tree, so it need not be threaded by hand (2a).
2. **A scope/nursery primitive** — a standard construct that owns child tasks
   and guarantees join-or-cancel on exit (2b).
3. **Cancellable `await` ergonomics** — a blessed checkpoint so cooperative
   tasks can opt into prompt unwinding without boilerplate.

## 6. Proposed directions (tractable, not preemptive)

### 6a. Ambient cancellation via AsyncContext
[AsyncContext](https://github.com/tc39/proposal-async-context) (Stage 2) gives
values that propagate along the async call tree. A standard
`AbortSignal`-carrying context variable would let a scope set the "current
signal" once, and have descendants read it implicitly — killing the viral
threading in 2a **without any new cancellation semantics**. This is the
highest-leverage, lowest-risk step, and it reuses machinery already advancing.

### 6b. A structured-concurrency scope built on AsyncContext + AbortController
Given 6a, a `withScope`-style primitive (whether library or, eventually,
language) becomes natural: the scope publishes its signal into the ambient
context; `spawn` reads it; teardown is `await using`. reinsjs demonstrates the
full semantics in userland today and can serve as a reference.

### 6c. Cancellable-await ergonomics
A small, composable checkpoint — e.g. building on
`AbortSignal.prototype.throwIfAborted()` — that integrates with the ambient
signal from 6a, so `await` inside a scope can be made to throw promptly on
cancel with minimal ceremony.

### 6d. Document Workers as the preemptive answer
For the genuinely uncooperative (CPU-bound) case, the platform answer is
`Worker.terminate()`. This should be acknowledged as the intended mechanism
rather than waiting for a language feature that cannot exist (§3).

## 7. Relationship to existing TC39 work

- **`proposal-cancelable-promises`** — withdrawn (2016). A new "cancel" proposal
  would be closed as a duplicate; this write-up deliberately is **not** one.
- **`proposal-cancellation`** — Stage 1, dormant; committee deferred to
  `AbortController`. The right move is to build on `AbortSignal`, not replace it.
- **AsyncContext** — Stage 2, actively progressing. This is the vehicle for 6a.
- **`bakkot/structured-concurrency-for-js`** — an exploration by a committee
  delegate. The right venue for 6b/6c discussion and real-world use-cases.
- **Explicit Resource Management** (`using`/`await using`) — Stage 3, shipping.
  Already the teardown mechanism for scope objects (reinsjs uses it today).

## 8. Concrete asks

1. Add (or prototype, in userland) an **AbortSignal-carrying AsyncContext
   variable** and gather feedback on ambient cancellation ergonomics.
2. Treat **structured concurrency** as a consumer of AsyncContext + Explicit
   Resource Management, not as a new cancellation primitive — and use reinsjs /
   Effection / Trio as prior-art references.
3. Explicitly document **Workers as the preemptive escape hatch**, closing the
   "why can't I kill it" question with the honest answer.

## 9. References

- AsyncContext — https://github.com/tc39/proposal-async-context
- Explicit Resource Management — https://github.com/tc39/proposal-explicit-resource-management
- Cancelable Promises (withdrawn) — https://github.com/tc39/proposal-cancelable-promises
- Cancellation (Stage 1, dormant) — https://github.com/tc39/proposal-cancellation
- Structured concurrency exploration — https://github.com/bakkot/structured-concurrency-for-js
- Trio nurseries — https://trio.readthedocs.io/en/stable/reference-core.html
- "Notes on structured concurrency" (Nathaniel J. Smith) — https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful/
- reinsjs — https://github.com/webcoderspeed/reins
