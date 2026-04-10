import { useState, useEffect, useRef } from "react";
import type { LogEntry } from "../types";

export interface CollapsedLogEntry extends LogEntry {
  count: number;
}

/**
 * Fetch initial logs + SSE stream for live updates.
 * Returns collapsed logs (consecutive duplicates merged with count badge).
 */
export function useLogs(
  workflow: string,
  itemId: string | null,
  runId: string | null,
  date: string,
): { logs: CollapsedLogEntry[]; loading: boolean } {
  const [rawLogs, setRawLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const prevLenRef = useRef(0);

  useEffect(() => {
    if (!itemId) {
      setRawLogs([]);
      setLoading(false);
      return;
    }
    setRawLogs([]);
    prevLenRef.current = 0;
    setLoading(true);

    // Build query params
    const params = new URLSearchParams({ workflow, id: itemId });
    if (runId) params.set("runId", runId);
    if (date) params.set("date", date);

    // Initial fetch
    fetch("/api/logs?" + params.toString())
      .then((r) => r.json())
      .then((entries: LogEntry[]) => {
        if (Array.isArray(entries) && entries.length > 0) {
          setRawLogs(entries);
          prevLenRef.current = entries.length;
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));

    // SSE for live updates
    const es = new EventSource("/events/logs?" + params.toString());
    es.onmessage = (e) => {
      try {
        const newEntries: LogEntry[] = JSON.parse(e.data);
        if (Array.isArray(newEntries) && newEntries.length > 0) {
          setRawLogs((prev) => [...prev, ...newEntries]);
        }
      } catch {}
    };

    return () => es.close();
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
