import { useEffect, useState } from "react";

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
 * `cache === null` means "never fetched"; an array (possibly empty) means
 * "we have a result." A failed fetch sets the cache to `[]`, matching the
 * pre-cache fallback behavior in RunModal.
 */
let cache: RosterListing[] | null = null;
let inflight: Promise<RosterListing[]> | null = null;
const subscribers = new Set<(rosters: RosterListing[] | null) => void>();

function notify(): void {
  for (const cb of subscribers) cb(cache);
}

async function fetchOnce(): Promise<RosterListing[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const resp = await fetch("/api/rosters");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as RosterListing[];
      cache = data;
      return data;
    } catch {
      cache = [];
      return [];
    } finally {
      inflight = null;
      notify();
    }
  })();
  return inflight;
}

/** Kick off the rosters fetch eagerly. Call from App mount. Idempotent. */
export function prefetchRosters(): void {
  if (cache !== null || inflight) return;
  void fetchOnce();
}

/** Force a refetch — used after operations that may have mutated the rosters
 *  directory (e.g. SharePoint download completion). */
export function refreshRosters(): void {
  inflight = null;
  void fetchOnce();
}

/** Subscribe to the rosters cache. Triggers a fetch if nothing is cached or
 *  in flight. Returns the current value (or `null` if not yet loaded). */
export function useRosters(): RosterListing[] | null {
  const [rosters, setRosters] = useState<RosterListing[] | null>(cache);

  useEffect(() => {
    subscribers.add(setRosters);
    if (cache === null && !inflight) void fetchOnce();
    return () => {
      subscribers.delete(setRosters);
    };
  }, []);

  return rosters;
}
