import { createCachedResource } from "./resource-factory";

export interface RosterListing {
  filename: string;
  path: string;
  bytes: number;
  modifiedAt: string;
}

/**
 * Module-level rosters cache shared across every consumer of `useRosters`.
 * Primed once at App mount via `prefetchRosters()` so RunModal's first paint
 * already has the data — no "Loading rosters…" frame.
 *
 * `cache === null` means "never fetched (or the only fetch attempt so far
 * failed)"; an array (possibly empty) means "we have a CONFIRMED result." A
 * failed fetch does NOT settle the cache to `[]` — that would read identically
 * to a genuinely empty roster directory and silently steer a run into
 * fresh-download mode (fail-loud: see root CLAUDE.md). Failures instead flip
 * `useRostersError()`; consumers that treat an empty list as meaningful (e.g.
 * RunModal's roster picker) must check that flag before trusting an empty
 * result.
 */
const resource = createCachedResource<RosterListing[]>({
  fetcher: async () => {
    const resp = await fetch("/api/rosters");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as RosterListing[];
  },
  fallback: [],
});

/** Kick off the rosters fetch eagerly. Call from App mount. Idempotent. */
export function prefetchRosters(): void {
  resource.prefetch();
}

/** Force a refetch — used after operations that may have mutated the rosters
 *  directory (e.g. SharePoint download completion). */
export function refreshRosters(): void {
  resource.refresh();
}

/** Subscribe to the rosters cache. Triggers a fetch if nothing is cached or
 *  in flight. Returns the current value (or `null` if not yet loaded). */
export function useRosters(): RosterListing[] | null {
  return resource.useResource();
}

/**
 * Subscribe to whether the most recent `/api/rosters` fetch attempt failed.
 * A `false` here means the current `useRosters()` value (including an empty
 * array) is a confirmed result, not a swallowed error masquerading as "no
 * roster on disk".
 */
export function useRostersError(): boolean {
  return resource.useError();
}
