import { useState, useEffect, useRef } from "react";
import type { RunEvent } from "../types";

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

    // Build query params
    const params = new URLSearchParams({ workflow, id: itemId, runId });
    if (date) params.set("date", date);

    let gotSseData = false;

    const es = new EventSource("/events/run-events?" + params.toString());
    es.onmessage = (e) => {
      try {
        const newEntries: RunEvent[] = JSON.parse(e.data);
        if (!Array.isArray(newEntries) || newEntries.length === 0) return;

        if (!gotSseData) {
          setEvents(newEntries);
          setLoading(false);
          gotSseData = true;
        } else {
          setEvents((prev) => [...prev, ...newEntries]);
        }
      } catch {}
    };
    es.onerror = () => setLoading(false);

    return () => {
      es.close();
    };
  }, [workflow, itemId, runId, date]);

  return { events, loading };
}
