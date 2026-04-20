import { useEffect, useState } from "react";

export interface ScreenshotEntry {
  ts: number;
  kind: "form" | "error" | "manual";
  label: string;
  step: string | null;
  files: Array<{ system: string; path: string; url: string }>;
}

/**
 * Fetches grouped ScreenshotEntry[] from /api/screenshots for a given
 * (workflow, itemId) pair and re-fetches whenever a `screenshot` session
 * event arrives on the /events/run-events SSE stream.
 *
 * Mirrors useRunEvents' structure: one EventSource, cleaned up on deps
 * change, cancelled flag guards async fetch races.
 */
export function useRunScreenshots(
  workflow: string | null,
  itemId: string | null,
  runId: string | null,
  date: string | null,
): { entries: ScreenshotEntry[] } {
  const [entries, setEntries] = useState<ScreenshotEntry[]>([]);

  useEffect(() => {
    if (!workflow || !itemId) return;
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const res = await fetch(
          `/api/screenshots?workflow=${encodeURIComponent(workflow)}&itemId=${encodeURIComponent(itemId)}`,
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as ScreenshotEntry[];
        if (!cancelled) setEntries(data);
      } catch {
        // Swallow — stale network or cancelled navigation is fine.
      }
    };

    void fetchOnce();

    // Re-fetch when the SSE stream notifies us a new screenshot landed.
    // /events/run-events carries all session-event types (including
    // `type === "screenshot"`) in the unnamed SSE data stream — no
    // separate named event is needed. We only need the notification,
    // not the payload itself, so we re-fetch once and discard the body.
    const params = new URLSearchParams({ workflow, id: itemId });
    if (runId) params.set("runId", runId);
    if (date) params.set("date", date);

    const es = new EventSource("/events/run-events?" + params.toString());
    es.onmessage = (e) => {
      try {
        const newEvents: Array<{ type?: string }> = JSON.parse(e.data);
        if (!Array.isArray(newEvents)) return;
        const hasScreenshot = newEvents.some((ev) => ev?.type === "screenshot");
        if (hasScreenshot && !cancelled) {
          void fetchOnce();
        }
      } catch {
        // Ignore parse errors.
      }
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, [workflow, itemId, runId, date]);

  return { entries };
}
