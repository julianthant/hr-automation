import { useMemo } from "react";
import type { LogEntry } from "@/components/shared/types";
import { useSseHistoryStream } from "./useSseHistoryStream";

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
  const { entries: rawLogs, loading } = useSseHistoryStream<LogEntry>("logs", {
    workflow,
    itemId,
    runId,
    date,
  }, {
    replaceFn: capLogWindow,
    appendFn: appendCappedLogs,
  });

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
