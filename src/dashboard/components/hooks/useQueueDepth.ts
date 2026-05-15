import { useEffect, useState } from "react";

/**
 * Polls /api/queue-depth every 5s. Returns a {workflow: depth} map.
 *
 * Module-level singleton: one fetch + one interval shared across all
 * subscribers. Without this, every WorkflowBox + WorkflowRail mount spins
 * its own independent poll, and on a busy dashboard those redundant
 * fetches pile up behind the SSE streams that already saturate Chrome's
 * HTTP/1.1 6-per-origin connection pool — manifesting as a refresh hang
 * with hundreds of pending /api/queue-depth requests in the network tab.
 */

let cache: Record<string, number> = {};
const subscribers = new Set<(depth: Record<string, number>) => void>();
let interval: ReturnType<typeof setInterval> | null = null;
let inflight = false;

type HotImportMeta = ImportMeta & {
  hot?: { dispose: (cb: () => void) => void };
};

const hot = (import.meta as HotImportMeta).hot;
if (hot) {
  hot.dispose(() => {
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
    subscribers.clear();
  });
}

async function fetchDepth(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const res = await fetch("/api/queue-depth");
    if (!res.ok) return;
    cache = (await res.json()) as Record<string, number>;
    for (const cb of subscribers) cb(cache);
  } catch {
    /* swallow — transient fetch failures shouldn't break the UI */
  } finally {
    inflight = false;
  }
}

export function useQueueDepth(): Record<string, number> {
  const [depth, setDepth] = useState<Record<string, number>>(cache);
  useEffect(() => {
    subscribers.add(setDepth);
    if (subscribers.size === 1) {
      void fetchDepth();
      interval = setInterval(fetchDepth, 5_000);
    }
    return () => {
      subscribers.delete(setDepth);
      if (subscribers.size === 0 && interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };
  }, []);
  return depth;
}
