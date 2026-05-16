import type { RunEvent } from "@/components/shared/types";
import { compact } from "@/lib/utils";
import { useSseHistoryStream } from "./useSseHistoryStream";

export const RAW_EVENTS_CAP = 5000;

export function capRunEventWindow(events: RunEvent[]): RunEvent[] {
  if (events.length <= RAW_EVENTS_CAP) return events;
  return events.slice(events.length - RAW_EVENTS_CAP);
}

export function appendCappedRunEvents(prev: RunEvent[], next: RunEvent[]): RunEvent[] {
  return capRunEventWindow([...prev, ...next]);
}

function buildRunEventParams({
  workflow,
  runId,
  date,
}: {
  workflow: string;
  itemId: string | null;
  runId: string | null;
  date: string;
}): Record<string, unknown> {
  return compact({ workflow, runId, date });
}

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
  const { entries, loading } = useSseHistoryStream<RunEvent>("runEvents", {
    workflow,
    itemId,
    runId,
    date,
  }, {
    enabled: Boolean(itemId && runId),
    replaceFn: capRunEventWindow,
    appendFn: appendCappedRunEvents,
    // The run-events topic keys on workflow/runId/date; `id` is intentionally
    // omitted to match the backend topic contract.
    buildParams: buildRunEventParams,
  });

  return { events: entries, loading };
}
