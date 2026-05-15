import { useState, useEffect, useRef, useMemo } from "react";
import type { LogEntry } from "@/components/shared/types";
import { sseHub } from "@/lib/sse-hub";

export interface CollapsedLogEntry extends LogEntry {
  count: number;
}

export const RAW_LOGS_CAP = 5000;

export function capLogWindow(logs: LogEntry[]): LogEntry[] {
  if (logs.length <= RAW_LOGS_CAP) return logs;
  return logs.slice(logs.length - RAW_LOGS_CAP);
}

export function appendCappedLogs(prev: LogEntry[], next: LogEntry[]): LogEntry[] {
  return capLogWindow([...prev, ...next]);
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

    // Build hub params
    const hubParams: { workflow: string; id: string; runId?: string; date?: string } = { workflow, id: itemId };
    if (runId) hubParams.runId = runId;
    if (date) hubParams.date = date;

    let gotSseData = false;

    const unsubscribe = sseHub.subscribe<LogEntry[]>(
      "logs",
      hubParams,
      (newEntries) => {
        if (!Array.isArray(newEntries)) return;

        if (!gotSseData) {
          // First tick carries the full (possibly-empty) history. Dismiss
          // the loading skeleton even when empty, so runs with no logs
          // (orphan-failed items, pre-start entries) don't hang forever.
          setRawLogs(capLogWindow(newEntries));
          setLoading(false);
          gotSseData = true;
        } else if (newEntries.length > 0) {
          setRawLogs((prev) => appendCappedLogs(prev, newEntries));
        }
      },
      () => {
        // Browser EventSource auto-reconnects on network blips or sleep+wake.
        // The backend sends a full history snapshot on the new connection's
        // first tick. Reset gotSseData so that first message replaces (not
        // appends) the current log state — without this, full history arrives
        // into the "delta" branch and duplicates every prior log line.
        gotSseData = false;
        setLoading(false);
      },
    );

    return () => {
      unsubscribe();
    };
  }, [workflow, itemId, runId, date]);

  // Collapse consecutive duplicate messages (memoized so it doesn't re-run on every parent render)
  const collapsed = useMemo(() => {
    const out: CollapsedLogEntry[] = [];
    for (const log of rawLogs) {
      const prev = out[out.length - 1];
      if (prev && prev.message === log.message) {
        prev.count++;
      } else {
        out.push({ ...log, count: 1 });
      }
    }
    return out;
  }, [rawLogs]);

  return { logs: collapsed, loading };
}
