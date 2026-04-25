import { useEffect, useState } from "react";

/**
 * Polls /api/queue-depth every 5s. Returns a {workflow: depth} map.
 * Cheap — the backend reads & folds the queue files which are small.
 * Polling rather than SSE because the data changes coarsely (a few
 * times per minute at most) and adding a new SSE channel for it would
 * be more wiring than it's worth.
 */
export function useQueueDepth(): Record<string, number> {
  const [depth, setDepth] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    const fetchDepth = async (): Promise<void> => {
      try {
        const res = await fetch("/api/queue-depth");
        if (!res.ok) return;
        const body = (await res.json()) as Record<string, number>;
        if (!cancelled) setDepth(body);
      } catch {
        /* swallow — transient fetch failures shouldn't break the UI */
      }
    };
    void fetchDepth();
    const interval = setInterval(fetchDepth, 5_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
  return depth;
}
