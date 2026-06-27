/**
 * Internal helpers. Not part of the public API.
 */

/**
 * Node emits a `MaxListenersExceededWarning` once more than 10 listeners attach
 * to a single `EventTarget`. A wide fan-out of cooperative tasks all forwarding
 * `scope.signal` (to `fetch`, {@link sleep}, etc.) can trip this on the scope's
 * own signal. On Node we lift the cap; on browsers/Deno/Bun this is a no-op.
 *
 * `node:events` is reached without a static import (which would pull it into a
 * browser bundle): synchronously via `process.getBuiltinModule` (Node 22+) or a
 * CJS `require`, with an async dynamic import as a last resort for older ESM.
 */
type SetMaxListeners = (n: number, target: EventTarget) => void;
type EventsModule = { setMaxListeners?: SetMaxListeners; default?: { setMaxListeners?: SetMaxListeners } };

let setMaxListenersFn: SetMaxListeners | null = null;

const nodeProcess = (globalThis as { process?: ProcessLike }).process;
const isNode = !!nodeProcess?.versions?.node;

interface ProcessLike {
  versions?: { node?: string };
  getBuiltinModule?: (id: string) => unknown;
}

function pick(mod: EventsModule | undefined): SetMaxListeners | null {
  return mod?.setMaxListeners ?? mod?.default?.setMaxListeners ?? null;
}

function loadSync(): void {
  if (setMaxListenersFn || !isNode) return;
  // Node 22+: synchronous and invisible to bundlers.
  try {
    const fromBuiltin = pick(nodeProcess?.getBuiltinModule?.('node:events') as EventsModule | undefined);
    if (fromBuiltin) {
      setMaxListenersFn = fromBuiltin;
      return;
    }
  } catch {
    /* ignore */
  }
  // CJS build (or a shimmed `require`, e.g. under tsx): synchronous require.
  try {
    // `typeof` guard is safe even when `require` is undefined (ESM).
    if (typeof require === 'function') {
      setMaxListenersFn = pick(require('node:events') as EventsModule);
    }
  } catch {
    /* ignore */
  }
}

// Last resort for ESM on Node 18/20 (no getBuiltinModule, no require): kick off
// an async load so later scopes benefit even if the first one missed.
if (isNode) {
  loadSync();
  if (!setMaxListenersFn) {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    import('node:events')
      .then((m) => {
        setMaxListenersFn = pick(m as unknown as EventsModule);
      })
      .catch(() => {
        /* best-effort */
      });
  }
}

/** Best-effort: remove the abort-listener cap on a scope's signal (Node only). */
export function liftListenerCap(signal: AbortSignal): void {
  if (!setMaxListenersFn) loadSync();
  try {
    setMaxListenersFn?.(0, signal);
  } catch {
    /* best-effort */
  }
}
