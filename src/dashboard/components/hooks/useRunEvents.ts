import { useState, useEffect, useRef } from "react";
import type { RunEvent } from "@/components/shared/types";
import { sseHub } from "@/lib/sse-hub";

/**
 * SSE consumer for /events/run-events. Twin of useLogs: one stream, delta
 * semantics, full history on first tick.
 *
 * Returns { events, loading }. Events are accumulated in arrival order;
 * the consumer handles sorting/filtering.
 */
export function useRunEvents(
  workflow: string,
  itemId: string | null,
  runId: string | null,
  date: string,
): { events: RunEvent[]; loading: boolean } {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loading, setLoading] = useState(true);

  // Track which itemId we're showing so we only clear when switching entries
  const prevItemIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!itemId || !runId) {
      setEvents([]);
      setLoading(false);
      prevItemIdRef.current = null;
      return;
    }

    // Only clear events when switching to a different entry entirely.
    // When runId changes (null → value, or run switch), keep showing
    // current events until the SSE delivers the replacement set.
    if (itemId !== prevItemIdRef.current) {
      setEvents([]);
      prevItemIdRef.current = itemId;
    }
    setLoading(true);

    // Build hub params (note: legacy /events/run-events accepted id but the
    // topic backend ignores it — only workflow, runId, and date are used)
    const hubParams: { workflow: string; runId: string; date?: string } = { workflow, runId };
    if (date) hubParams.date = date;

    let gotSseData = false;

    const unsubscribe = sseHub.subscribe<RunEvent[]>(
      "runEvents",
      hubParams,
      (newEntries) => {
        if (!Array.isArray(newEntries)) return;

        if (!gotSseData) {
          // First tick carries full history (possibly empty). Dismiss
          // skeleton even when empty so runs with no session events don't
          // stall the loading state forever.
          setEvents(newEntries);
          setLoading(false);
          gotSseData = true;
        } else if (newEntries.length > 0) {
          setEvents((prev) => [...prev, ...newEntries]);
        }
      },
      () => setLoading(false),
    );

    return () => {
      unsubscribe();
    };
  }, [workflow, itemId, runId, date]);

  return { events, loading };
}
