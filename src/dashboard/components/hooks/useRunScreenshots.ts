import { useEffect, useRef, useState } from "react";

export interface ScreenshotEntry {
  ts: number;
  kind: "form" | "error" | "manual";
  label: string;
  step: string | null;
  files: Array<{ system: string; path: string; url: string }>;
}

/**
 * Fetches grouped ScreenshotEntry[] from /api/screenshots for a given
 * (workflow, itemId) pair, refetching whenever the count of screenshot
 * session events changes. The caller (LogPanel) already subscribes to
 * `/events/run-events` via useRunEvents and computes the count from there
 * — this hook does NOT open its own EventSource.
 *
 * Why this hook used to open its own EventSource and why it doesn't now:
 * — Two SSE connections to `/events/run-events` for the same (workflow, id,
 *   runId) tuple were wasteful, AND because Vite proxies HTTP/1.1, every
 *   open EventSource holds one of Chrome's 6 per-origin connection slots.
 *   With useEntries + useLogs + useRunEvents + useSessions + this hook all
 *   open at once, plus a queue-depth poll, the slot pool was saturated.
 *   New /api/screenshots fetches sat in `pending` indefinitely and
 *   ScreenshotsPanel showed "No screenshots captured for this run yet."
 *   even after a screenshot landed.
 *
 * Superseded in-flight responses are dropped via a monotonic generation id (no
 * AbortSignal — abort-after-headers can race stream teardown on some stacks).
 */
export function useRunScreenshots(
  workflow: string | null,
  itemId: string | null,
  screenshotEventCount: number,
): { entries: ScreenshotEntry[] } {
  const [entries, setEntries] = useState<ScreenshotEntry[]>([]);
  const fetchGeneration = useRef(0);

  useEffect(() => {
    if (!workflow || !itemId) {
      setEntries([]);
      return;
    }

    const myGen = ++fetchGeneration.current;

    void (async () => {
      try {
        const res = await fetch(
          `/api/screenshots?workflow=${encodeURIComponent(workflow)}&itemId=${encodeURIComponent(itemId)}`,
        );
        if (myGen !== fetchGeneration.current) return;
        if (!res.ok) return;
        const data = (await res.json()) as ScreenshotEntry[];
        if (myGen !== fetchGeneration.current) return;
        setEntries(data);
      } catch {
        // Network or parse errors — next screenshotEventCount tick retries.
      }
    })();
    // screenshotEventCount intentionally drives refetch — it changes when a
    // new screenshot session_event arrives in useRunEvents.
  }, [workflow, itemId, screenshotEventCount]);

  return { entries };
}
