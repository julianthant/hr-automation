import { useState, useEffect, useRef } from "react";
import type { LogEntry } from "../types";

export interface CollapsedLogEntry extends LogEntry {
  count: number;
}

/**
 * Fetch initial logs + SSE stream for live updates.
 * Returns collapsed logs (consecutive duplicates merged with count badge).
 *
 * Strategy: SSE is the sole data source after connection. The initial fetch
 * is skipped — the backend SSE endpoint sends ALL existing logs on first
 * tick (within 500ms), then only new ones. This avoids the race condition
 * where initial fetch and SSE both return overlapping data.
 */
export function useLogs(
  workflow: string,
  itemId: string | null,
  runId: string | null,
  date: string,
): { logs: CollapsedLogEntry[]; loading: boolean } {
  const [rawLogs, setRawLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Track which itemId we're showing so we only clear when switching entries
  const prevItemIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!itemId) {
      setRawLogs([]);
      setLoading(false);
      prevItemIdRef.current = null;
      return;
    }

    // Only clear logs when switching to a different entry entirely.
    // When runId changes (null → value, or run switch), keep showing
    // current logs until the SSE delivers the replacement set.
    if (itemId !== prevItemIdRef.current) {
      setRawLogs([]);
      prevItemIdRef.current = itemId;
    }
    setLoading(true);

    // Build query params
    const params = new URLSearchParams({ workflow, id: itemId });
    if (runId) params.set("runId", runId);
    if (date) params.set("date", date);

    let gotSseData = false;

    const es = new EventSource("/events/logs?" + params.toString());
    es.onmessage = (e) => {
      try {
        const newEntries: LogEntry[] = JSON.parse(e.data);
        if (!Array.isArray(newEntries) || newEntries.length === 0) return;

        if (!gotSseData) {
          setRawLogs(newEntries);
          setLoading(false);
          gotSseData = true;
        } else {
          setRawLogs((prev) => [...prev, ...newEntries]);
        }
      } catch {}
    };
    es.onerror = () => setLoading(false);

    return () => {
      es.close();
    };
  }, [workflow, itemId, runId, date]);

  // Collapse consecutive duplicate messages
  const collapsed: CollapsedLogEntry[] = [];
  for (const log of rawLogs) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.message === log.message) {
      prev.count++;
    } else {
      collapsed.push({ ...log, count: 1 });
    }
  }

  return { logs: collapsed, loading };
}
