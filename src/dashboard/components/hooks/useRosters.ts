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
 * `cache === null` means "never fetched"; an array (possibly empty) means "we
 * have a result." A failed fetch settles the cache to `[]`.
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
