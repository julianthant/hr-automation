import { useEffect, useState } from "react";

/**
 * Shared factories for the dashboard's module-level resource hooks.
 *
 * Every dashboard data hook that polls a singleton endpoint (or shares one
 * fetch across N components) used to hand-roll the same machinery: a module
 * cache, a subscriber `Set`, an inflight guard, and an `import.meta.hot`
 * dispose. That boilerplate was copy-pasted across `useDaemons`,
 * `useQueueDepth`, `useNow`, `useRosters`, and `useFormTypes` — drifting
 * subtly between them. These two factories centralise it:
 *
 *   - `createPolledResource` — interval-polled singleton (daemons, queue depth,
 *     the shared clock, gated SharePoint status). Keeps one timer alive while
 *     ≥1 subscriber is mounted (and, when gated, enabled).
 *   - `createCachedResource` — fetch-once-with-refresh singleton (rosters, form
 *     types). `null` cache means "never fetched"; `refresh()` forces a refetch;
 *     `prefetch()` warms it eagerly; `peek()` reads it synchronously.
 *
 * Why a singleton, not per-component state: Chrome caps HTTP/1.1 at 6
 * connections per origin, and the dashboard already runs ~6 long-lived SSE
 * streams. N independent component polls pile up behind those streams and
 * manifest as a refresh hang with hundreds of pending requests. One shared
 * poll per resource stays well within budget.
 */

type HotImportMeta = ImportMeta & {
  hot?: { dispose: (cb: () => void) => void };
};

/** Register an HMR-dispose cleanup (no-op outside Vite dev). */
function onHotDispose(cleanup: () => void): void {
  const hot = (import.meta as HotImportMeta).hot;
  if (hot) hot.dispose(cleanup);
}

export interface PolledResource<T> {
  /** Subscribe to the polled value. `enabled=false` opts this subscriber out of keeping the poll alive. */
  useResource: (enabled?: boolean) => T;
  /** Force an immediate fetch outside the interval cadence. */
  refresh: () => void;
  /** Read the current cached value synchronously (no subscription). */
  peek: () => T;
}

export interface PolledResourceConfig<T> {
  /** One-shot fetch of the current value. Errors are swallowed (last value retained). */
  fetcher: () => Promise<T> | T;
  /** Poll cadence in milliseconds. */
  intervalMs: number;
  /** Seed value served before the first fetch resolves. */
  initial: T;
  /**
   * Optional shallow/identity comparator. When it returns true the new value is
   * dropped (subscribers are NOT notified), so an unchanged payload doesn't
   * re-render every tick. Defaults to `Object.is`.
   */
  equals?: (a: T, b: T) => boolean;
  /**
   * When true, the resource resets its cache to `initial` and stops polling once
   * no ENABLED subscriber remains. Used by gated resources (SharePoint status)
   * that should go quiet when their modal closes. Defaults to false (the poll
   * runs whenever any subscriber is mounted).
   */
  resetWhenIdle?: boolean;
}

/**
 * Build an interval-polled singleton resource. One timer + one inflight fetch
 * are shared across every subscriber; the timer runs while ≥1 enabled
 * subscriber is mounted.
 */
export function createPolledResource<T>(config: PolledResourceConfig<T>): PolledResource<T> {
  const equals = config.equals ?? Object.is;
  let cache: T = config.initial;
  const subscribers = new Set<(value: T) => void>();
  let enabledCount = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let inflight = false;

  function notify(): void {
    for (const cb of subscribers) cb(cache);
  }

  async function poll(): Promise<void> {
    if (inflight) return;
    inflight = true;
    try {
      const next = await config.fetcher();
      if (!equals(cache, next)) {
        cache = next;
        notify();
      }
    } catch {
      // best-effort — leave the previous value in place on transient errors.
    } finally {
      inflight = false;
    }
  }

  function stopInterval(): void {
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  }

  function startInterval(): void {
    if (interval === null) {
      interval = setInterval(() => void poll(), config.intervalMs);
    }
  }

  onHotDispose(() => {
    stopInterval();
    subscribers.clear();
    enabledCount = 0;
  });

  function useResource(enabled = true): T {
    const [value, setValue] = useState<T>(cache);
    useEffect(() => {
      subscribers.add(setValue);
      if (enabled) {
        enabledCount += 1;
        // Kick an immediate fetch + ensure the shared timer is running.
        void poll();
        startInterval();
      }
      return () => {
        subscribers.delete(setValue);
        if (enabled) {
          enabledCount -= 1;
          if (enabledCount <= 0) {
            enabledCount = 0;
            stopInterval();
            if (config.resetWhenIdle && !equals(cache, config.initial)) {
              cache = config.initial;
              notify();
            }
          }
        }
      };
    }, [enabled]);
    return value;
  }

  return {
    useResource,
    refresh: () => void poll(),
    peek: () => cache,
  };
}

export interface CachedResource<T> {
  /** Subscribe to the cached value. Triggers a fetch if nothing is cached or inflight. */
  useResource: () => T | null;
  /** Kick off the fetch eagerly (idempotent). Call from App mount. */
  prefetch: () => void;
  /** Force a refetch (e.g. after a mutation that changed the underlying data). */
  refresh: () => void;
  /** Read the current cache synchronously (`null` until first fetch resolves). */
  peek: () => T | null;
}

export interface CachedResourceConfig<T> {
  /** Fetch the value once. A thrown/rejected fetch resolves the cache to {@link CachedResourceConfig.fallback}. */
  fetcher: () => Promise<T>;
  /** Value the cache settles to when the fetch fails. */
  fallback: T;
}

/**
 * Build a fetch-once-with-refresh singleton resource. The cache is `null` until
 * the first fetch resolves; a failed fetch settles it to `fallback`.
 */
export function createCachedResource<T>(config: CachedResourceConfig<T>): CachedResource<T> {
  let cache: T | null = null;
  let inflight: Promise<T> | null = null;
  const subscribers = new Set<(value: T | null) => void>();

  function notify(): void {
    for (const cb of subscribers) cb(cache);
  }

  function fetchOnce(): Promise<T> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const data = await config.fetcher();
        cache = data;
        return data;
      } catch {
        cache = config.fallback;
        return config.fallback;
      } finally {
        inflight = null;
        notify();
      }
    })();
    return inflight;
  }

  onHotDispose(() => {
    subscribers.clear();
  });

  return {
    useResource(): T | null {
      const [value, setValue] = useState<T | null>(cache);
      useEffect(() => {
        subscribers.add(setValue);
        if (cache === null && !inflight) void fetchOnce();
        return () => {
          subscribers.delete(setValue);
        };
      }, []);
      return value;
    },
    prefetch(): void {
      if (cache !== null || inflight) return;
      void fetchOnce();
    },
    refresh(): void {
      inflight = null;
      void fetchOnce();
    },
    peek: () => cache,
  };
}

/**
 * Local (non-singleton) interval hook. Runs `callback` every `delayMs` while
 * `delayMs` is non-null; pass `null` to pause. Replaces the hand-rolled
 * `setInterval` + cleanup in per-parameter / tick-bump hooks that can't share a
 * module-level singleton (the callback or cadence is component-scoped).
 */
export function useInterval(callback: () => void, delayMs: number | null): void {
  useEffect(() => {
    if (delayMs === null) return;
    const id = window.setInterval(callback, delayMs);
    return () => window.clearInterval(id);
    // The caller owns `callback` identity stability (wrap in useCallback when it
    // closes over changing state, or accept a fresh interval per change).
  }, [callback, delayMs]);
}
