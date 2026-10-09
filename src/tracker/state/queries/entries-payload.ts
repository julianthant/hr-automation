import type { Database } from "../../../infra/sqlite/index.js";
import { computeFailureCounts } from "../../dashboard/failures.js";
import { computeStepDurations, pickEarlier, pickLater } from "../../dashboard/run-timelines.js";
import type { ProjectionEntriesPayload } from "../types.js";
import { dateLocal, type TrackerEntry } from "../../jsonl-io.js";
import {
  countSidebarQueuedRowsFromTrackerHistory,
  countSidebarRowsFromTrackerHistory,
} from "../../queue-row-count.js";
import { log } from "../../../utils/log.js";
import { isTrackerStatus, parseJsonObject, parseTypedDataJson, readStmts } from "./statements.js";
import {
  type CrossMidnightEventRow,
  dateCanHaveContinuation,
  openRunIdsFromEvents,
  selectCrossMidnightEventRowsWithRuns,
} from "./cross-midnight.js";
import {
  filterRetiredDashboardWorkflowCounts,
  filterRetiredDashboardWorkflows,
} from "../../../domain/dashboard-run-surfaces.js";

// ── resolvedEmplIdMapFromRunEvents ────────────────────────────────────────────

const WF_ITEM_KEY_SEP = "\u0000";
const RESOLVED_EMPL_CACHE_TTL_MS = 1_000;
const RESOLVED_EMPL_CACHE_MAX = 10_000;
const resolvedEmplCache = new WeakMap<Database, { trackerDate: string; computedAt: number; value: Map<string, string> }>();

/**
 * Reads `items.latest_empl_id` (projected at write time) for all items on
 * `trackerDate`. One indexed SELECT replaces the previous `json_extract` scan
 * over run_events. Result is cached with a 1s TTL and evicted on date change.
 * Skips caching when the result exceeds RESOLVED_EMPL_CACHE_MAX entries.
 */
function resolvedEmplIdMapFromRunEvents(db: Database, trackerDate: string): Map<string, string> {
  const cached = resolvedEmplCache.get(db);
  const now = Date.now();
  if (
    cached &&
    cached.trackerDate === trackerDate &&
    now - cached.computedAt < RESOLVED_EMPL_CACHE_TTL_MS
  ) {
    return cached.value;
  }
  const out = new Map<string, string>();
  const rows = readStmts(db).selectResolvedEmplIds.all({ date: trackerDate }) as Array<{ workflow: string; item_id: string; latest_empl_id: string }>;
  for (const row of rows) {
    out.set(`${row.workflow}${WF_ITEM_KEY_SEP}${row.item_id}`, row.latest_empl_id);
  }
  if (out.size <= RESOLVED_EMPL_CACHE_MAX) {
    resolvedEmplCache.set(db, { trackerDate, computedAt: now, value: out });
  }
  return out;
}

function patchItemDataWithCarriedEmpl(
  workflow: string,
  itemId: string,
  data: Record<string, string>,
  resolvedEmplIds: Map<string, string>,
): Record<string, string> {
  const carried = resolvedEmplIds.get(`${workflow}${WF_ITEM_KEY_SEP}${itemId}`);
  if (carried && (!data.emplId || String(data.emplId).trim() === "")) {
    return { ...data, emplId: carried };
  }
  return data;
}

// ── cross-midnight forward merge ──────────────────────────────────────────────

/**
 * Forward-merge continuation events for runs that crossed local midnight, for
 * the queue card. Delegates the open-run detection + bounded `(date, today]`
 * fetch to the shared {@link selectCrossMidnightEventRowsWithRuns}; the only
 * card-specific step here is making each continuation row inherit the run's TRUE
 * start aggregates from `date`, so the collapsed card shows the whole-run
 * elapsed span — not the near-zero span of the terminal-only later partition.
 *
 * The caller folds the returned rows into the event stream so the dashboard's
 * latest-wins dedupe collapses the run to its real terminal row. No-op when
 * viewing today (a run can only continue into a partition at/after its start
 * day). See `cross-midnight.ts` for the full rationale.
 */
function forwardMergeCrossMidnightRows(
  db: Database,
  workflow: string,
  date: string,
  eventRows: CrossMidnightEventRow[],
): CrossMidnightEventRow[] {
  const today = dateLocal();
  if (!dateCanHaveContinuation(date, today)) return [];

  const openRunIds = openRunIdsFromEvents(eventRows);
  if (openRunIds.length === 0) return [];

  // eventRows are ordered event_ms ASC, so the first row per run carries the
  // run's start aggregates (identical across the run's rows on this date — the
  // partition's `runs` row).
  const startAggByRun = new Map<string, {
    first_any_ts: string;
    first_work_ts: string | null;
    first_log_ts: string | null;
    run_ordinal: number;
    screenshot_count: number;
  }>();
  for (const row of eventRows) {
    if (!startAggByRun.has(row.run_id)) {
      startAggByRun.set(row.run_id, {
        first_any_ts: row.first_any_ts,
        first_work_ts: row.first_work_ts,
        first_log_ts: row.first_log_ts,
        run_ordinal: row.run_ordinal,
        screenshot_count: row.screenshot_count,
      });
    }
  }

  return selectCrossMidnightEventRowsWithRuns(db, { workflow, date, openRunIds, today }).map((raw) => {
    const startAgg = startAggByRun.get(raw.run_id);
    // Inherit the run's true start from `date` so elapsed/duration reflect the
    // whole run, not just the terminal-only later partition.
    return startAgg
      ? {
          ...raw,
          first_any_ts: startAgg.first_any_ts,
          first_work_ts: startAgg.first_work_ts,
          first_log_ts: startAgg.first_log_ts,
          run_ordinal: startAgg.run_ordinal,
          screenshot_count: Math.max(startAgg.screenshot_count, raw.screenshot_count),
        }
      : raw;
  });
}

export function queryEntriesPayload(
  db: Database,
  opts: { workflow: string; date: string },
): ProjectionEntriesPayload {
  const rawEventRows = readStmts(db).selectRunEventsWithRunsForDate.all({ workflow: opts.workflow, date: opts.date }) as Array<{
    id: number;
    workflow: string;
    event_ts: string;
    item_id: string;
    run_id: string;
    parent_run_id: string | null;
    status: unknown;
    step: string | null;
    data_json: string | null;
    typed_data_json: string | null;
    input_json: string | null;
    error: string | null;
    first_log_ts: string | null;
    last_log_ts: string | null;
    last_log_message: string | null;
    run_ordinal: number;
    screenshot_count: number;
    first_any_ts: string;
    first_work_ts: string | null;
    latest_tracker_ts: string;
  }>;
  const eventRows: CrossMidnightEventRow[] = [];
  for (const row of rawEventRows) {
    if (isTrackerStatus(row.status)) {
      eventRows.push({ ...row, status: row.status });
    } else {
      log.warn(
        `[queries] queryEntriesPayload: dropping event row with unknown status workflow=${row.workflow} itemId=${row.item_id} runId=${row.run_id} status=${String(row.status)}`,
      );
    }
  }

  // Fold in terminal/continuation events for any run that crossed local
  // midnight, so a run cancelled/approved/completed after midnight no longer
  // shows stuck at its last pre-midnight status on its start-day view.
  for (const row of forwardMergeCrossMidnightRows(db, opts.workflow, opts.date, eventRows)) {
    eventRows.push(row);
  }

  const historyByRun = new Map<string, Array<{ timestamp: string; status: TrackerEntry["status"]; step?: string }>>();
  for (const row of eventRows) {
    const key = `${row.item_id}::${row.run_id}`;
    const arr = historyByRun.get(key) ?? [];
    arr.push({ timestamp: row.event_ts, status: row.status, ...(row.step ? { step: row.step } : {}) });
    historyByRun.set(key, arr);
  }

  const entries = eventRows.map((row) => {
    const key = `${row.item_id}::${row.run_id}`;
    const firstLogTs = pickEarlier(row.first_log_ts ?? undefined, row.first_work_ts ?? row.first_any_ts);
    const lastLogTs = pickLater(row.last_log_ts ?? undefined, row.latest_tracker_ts);
    const typedData = parseTypedDataJson(row.typed_data_json, {
      mapper: "queryEntriesPayload",
      rowId: row.id,
    });
    return {
      workflow: row.workflow,
      timestamp: row.event_ts,
      id: row.item_id,
      runId: row.run_id,
      ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
      status: row.status,
      ...(row.step ? { step: row.step } : {}),
      data: parseJsonObject(row.data_json, {}),
      ...(typedData ? { typedData } : {}),
      ...(row.input_json ? { input: parseJsonObject(row.input_json, {}) } : {}),
      ...(row.error ? { error: row.error } : {}),
      firstLogTs,
      lastLogTs,
      ...(row.last_log_message ? { lastLogMessage: row.last_log_message } : {}),
      stepDurations: computeStepDurations(historyByRun.get(key) ?? []),
      runOrdinal: row.run_ordinal,
      ...(row.status === "failed" ? { screenshotCount: row.screenshot_count } : {}),
    };
  });

  const workflows = filterRetiredDashboardWorkflows(
    (readStmts(db).selectDistinctWorkflowsForDate.all({ date: opts.date }) as Array<{ workflow: string }>)
      .map((r) => r.workflow),
  );

  const resolvedEmplFromDay = resolvedEmplIdMapFromRunEvents(db, opts.date);

  const wfCounts: Record<string, number> = {};
  const wfQueuedCounts: Record<string, number> = {};
  const rawWfCountRows = readStmts(db).selectWfCountRowsForDate.all({ date: opts.date }) as Array<{
    workflow: string;
    id: string;
    runId: string;
    parent_run_id: string | null;
    status: unknown;
    step: string | null;
    timestamp: string;
    data_json: string | null;
    error: string | null;
  }>;
  const wfCountRows: Array<{
    workflow: string;
    id: string;
    runId: string;
    parent_run_id: string | null;
    status: TrackerEntry["status"];
    step: string | null;
    timestamp: string;
    data_json: string | null;
    error: string | null;
  }> = [];
  for (const row of rawWfCountRows) {
    if (isTrackerStatus(row.status)) {
      wfCountRows.push({ ...row, status: row.status });
    } else {
      log.warn(
        `[queries] queryEntriesPayload: dropping wfCount row with unknown status workflow=${row.workflow} row=${row.id} runId=${row.runId} status=${String(row.status)}`,
      );
    }
  }

  const rowsByWorkflowForCount = new Map<string, typeof wfCountRows>();
  for (const row of wfCountRows) {
    const bucket = rowsByWorkflowForCount.get(row.workflow);
    if (bucket) bucket.push(row);
    else rowsByWorkflowForCount.set(row.workflow, [row]);
  }

  for (const wf of workflows) {
    const rows = rowsByWorkflowForCount.get(wf) ?? [];
    const asTracker: TrackerEntry[] = rows.map((row) => ({
      workflow: row.workflow,
      timestamp: row.timestamp,
      id: row.id,
      runId: row.runId,
      ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
      status: row.status,
      ...(row.step ? { step: row.step } : {}),
      data: patchItemDataWithCarriedEmpl(
        row.workflow,
        row.id,
        parseJsonObject(row.data_json, {}),
        resolvedEmplFromDay,
      ),
      ...(row.error ? { error: row.error } : {}),
    }));
    wfCounts[wf] = countSidebarRowsFromTrackerHistory(asTracker);
    wfQueuedCounts[wf] = countSidebarQueuedRowsFromTrackerHistory(asTracker);
  }

  const failureCounts: Record<string, number> = {};
  // One query for ALL workflows on this date, partition in JS.
  // Replaces the prior per-workflow N+1 (one prepared statement per
  // workflow per tick per connected SSE client).
  const rawAllLatestRows = readStmts(db).selectAllLatestRowsForDate.all({ date: opts.date }) as Array<{
    workflow: string;
    timestamp: string;
    id: string;
    runId: string;
    status: unknown;
    step?: string | null;
    data_json?: string | null;
    error?: string | null;
  }>;
  const allLatestRows: Array<{
    workflow: string;
    timestamp: string;
    id: string;
    runId: string;
    status: TrackerEntry["status"];
    step?: string | null;
    data_json?: string | null;
    error?: string | null;
  }> = [];
  for (const row of rawAllLatestRows) {
    if (isTrackerStatus(row.status)) {
      allLatestRows.push({ ...row, status: row.status });
    } else {
      log.warn(
        `[queries] queryEntriesPayload: dropping allLatest row with unknown status workflow=${row.workflow} id=${row.id} runId=${row.runId} status=${String(row.status)}`,
      );
    }
  }

  const rowsByWorkflow = new Map<string, typeof allLatestRows>();
  for (const row of allLatestRows) {
    const bucket = rowsByWorkflow.get(row.workflow);
    if (bucket) bucket.push(row);
    else rowsByWorkflow.set(row.workflow, [row]);
  }

  for (const wf of workflows) {
    const latestRows = rowsByWorkflow.get(wf) ?? [];
    if (latestRows.length === 0) continue;
    const n = computeFailureCounts(latestRows.map((row) => ({
      workflow: row.workflow,
      timestamp: row.timestamp,
      id: row.id,
      runId: row.runId,
      status: row.status,
      ...(row.step ? { step: row.step } : {}),
      data: parseJsonObject(row.data_json, {}),
      ...(row.error ? { error: row.error } : {}),
    })));
    if (n > 0) failureCounts[wf] = n;
  }

  return {
    entries,
    workflows,
    wfCounts: filterRetiredDashboardWorkflowCounts(wfCounts),
    wfQueuedCounts: filterRetiredDashboardWorkflowCounts(wfQueuedCounts),
    failureCounts: filterRetiredDashboardWorkflowCounts(failureCounts),
    source: "sqlite",
  };
}
