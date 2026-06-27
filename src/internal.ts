/**
 * Internal helpers. Not part of the public API.
 */

/**
 * Node emits a `MaxListenersExceededWarning` once more than 10 listeners attach
 * to a single `EventTarget`. A wide fan-out of cooperative tasks all forwarding
 * `scope.signal` (to `fetch`, {@link sleep}, etc.) can trip this on the scope's
 * own signal. On Node we lift the cap; on browsers/Deno/Bun this is a no-op.
 *
 * The `node:events` module is loaded via a guarded dynamic import so it never
 * ends up in a browser bundle. Loading is kicked off at module-eval time, so by
 * the time user code calls `withScope` the function is almost always ready.
 */
let setMaxListenersFn: ((n: number, target: EventTarget) => void) | null = null;

const isNode =
  typeof process !== 'undefined' &&
  !!(process as { versions?: { node?: string } }).versions?.node;

type SetMaxListeners = (n: number, target: EventTarget) => void;
type EventsModule = { setMaxListeners?: SetMaxListeners; default?: { setMaxListeners?: SetMaxListeners } };

if (isNode) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  import('node:events')
    .then((m) => {
      const mod = m as unknown as EventsModule;
      setMaxListenersFn = mod.setMaxListeners ?? mod.default?.setMaxListeners ?? null;
    })
    .catch(() => {
      /* best-effort: stay a no-op if node:events is unavailable */
    });
}

/** Best-effort: remove the abort-listener cap on a scope's signal (Node only). */
export function liftListenerCap(signal: AbortSignal): void {
  try {
    setMaxListenersFn?.(0, signal);
  } catch {
    /* best-effort */
  }
}
