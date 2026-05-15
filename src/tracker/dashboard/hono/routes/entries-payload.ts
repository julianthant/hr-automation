/**
 * JSONL-fallback payload builder for the `/events` (entries) SSE topic.
 *
 * Extracted here so both `routes/events.ts` and `topics-emitters.ts` can
 * import it without creating a circular dependency.
 *
 * The cross-workflow counts cache (`getCrossWorkflowCounts`) and its reset
 * function (`__resetCrossWorkflowCountsCacheForTests`) live here so they stay
 * co-located with the code that uses them.
 */
import {
  existsSync,
  readdirSync,
} from "node:fs";
import {
  listWorkflows,
  readEntries,
  readEntriesForDate,
  readLogEntries,
  readLogEntriesForDate,
  getRunIdOr,
  type TrackerEntry,
} from "../../../jsonl.js";
import {
  buildRunTimelines,
  computeStepDurations,
  pickEarlier,
  pickLater,
  type RunTimeline,
  type StepDurationEntry,
} from "../../run-timelines.js";
import { isResolvedPrepEntry } from "../../prep-rows.js";
import { computeFailureCounts } from "../../failures.js";
import { SCREENSHOTS_DIR } from "../../screenshots.js";
import { countSidebarRowsFromTrackerHistory } from "../../../queue-row-count.js";
import { ttlMemoize } from "../memo.js";
import { isStateDbReady, openStateDb } from "../../../state/db.js";

// ── Cross-workflow counts cache ───────────────────────────────────────────────

const CROSS_WORKFLOW_COUNTS_TTL_MS = 1_000;

/**
 * TTL cache for the cross-workflow `wfCounts` + `failureCounts` aggregation.
 *
 * The `/events` JSONL-fallback path otherwise re-reads every workflow's
 * tracker JSONL on every 1s tick, regardless of which workflow the client
 * is subscribed to. Under multi-workflow load that's the dominant cost in
 * `buildJsonlEventsPayload` — a sync directory scan + N file reads + N
 * dedupe passes + N failure-count computations, all blocking the Node
 * event loop and queueing other concurrent fetches behind it.
 *
 * The TTL matches the SSE poll cadence (1s), so within any given second
 * the heavy aggregation runs at most once across all connected clients.
 * The cache key includes (dir, targetDate) so date switches and test
 * isolation directories don't share state.
 */
const getCrossWorkflowCounts = ttlMemoize(
  CROSS_WORKFLOW_COUNTS_TTL_MS,
  (targetDate: string, dir: string) => `${dir}::${targetDate}`,
  function getCrossWorkflowCounts(
    targetDate: string,
    dir: string,
  ): { workflows: string[]; wfCounts: Record<string, number>; failureCounts: Record<string, number> } {
    const workflows = listWorkflows(dir);
    const wfCounts: Record<string, number> = {};
    const failureCounts: Record<string, number> = {};
    for (const wf of workflows) {
      const all = readEntriesForDate(wf, targetDate, dir);
      wfCounts[wf] = countSidebarRowsFromTrackerHistory(all, isResolvedPrepEntry);
      const failures = computeFailureCounts(all);
      if (failures > 0) failureCounts[wf] = failures;
    }
    return { workflows, wfCounts, failureCounts };
  },
);

export function __resetCrossWorkflowCountsCacheForTests(): void {
  getCrossWorkflowCounts.reset();
}

// ── Payload builder ───────────────────────────────────────────────────────────

function readTrackerEntriesForStream(
  workflow: string,
  date: string,
  today: string,
  dir: string,
): TrackerEntry[] {
  return date && date !== today
    ? readEntriesForDate(workflow, date, dir)
    : readEntries(workflow, dir);
}

function countScreenshotsForItems(
  workflow: string,
  itemIds: Set<string>,
  trackerDate: string,
  trackerDir: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of itemIds) counts.set(id, 0);
  if (itemIds.size === 0) return counts;

  if (isStateDbReady(trackerDir)) {
    const db = openStateDb(trackerDir);
    const rows = db.prepare(`
      SELECT item_id, SUM(screenshot_count) AS n
      FROM runs
      WHERE workflow = ?
        AND tracker_date = ?
        AND item_id IN (${[...itemIds].map(() => "?").join(",")})
      GROUP BY item_id
    `).all(workflow, trackerDate, ...itemIds) as Array<{ item_id: string; n: number | null }>;
    for (const row of rows) counts.set(row.item_id, row.n ?? 0);
    return counts;
  }

  if (!existsSync(SCREENSHOTS_DIR)) return counts;
  const ids = [...itemIds].sort((a, b) => b.length - a.length);
  for (const f of readdirSync(SCREENSHOTS_DIR)) {
    if (!f.endsWith(".png")) continue;
    for (const id of ids) {
      if (!f.startsWith(`${workflow}-${id}-`)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      break;
    }
  }
  return counts;
}

export function buildJsonlEventsPayload(
  workflow: string,
  date: string,
  today: string,
  dir: string,
): {
  entries: Array<TrackerEntry & {
    firstLogTs?: string;
    lastLogTs?: string;
    lastLogMessage?: string;
    stepDurations: Record<string, number>;
    runOrdinal?: number;
    screenshotCount?: number;
  }>;
  workflows: string[];
  wfCounts: Record<string, number>;
  failureCounts: Record<string, number>;
} {
  const entries = readTrackerEntriesForStream(workflow, date, today, dir);
  const logs = date && date !== today
    ? readLogEntriesForDate(workflow, undefined, date, dir)
    : readLogEntries(workflow, undefined, dir);

  const logFirst = new Map<string, string>();
  const logLast = new Map<string, string>();
  const logLastMsg = new Map<string, string>();
  for (const entry of logs) {
    const runId = entry.runId || `${entry.itemId}#1`;
    const key = `${entry.itemId}::${runId}`;
    if (!logFirst.has(key)) logFirst.set(key, entry.ts);
    logLast.set(key, entry.ts);
    logLastMsg.set(key, entry.message);
  }

  const runHistory = new Map<string, StepDurationEntry[]>();
  for (const entry of entries) {
    const runId = getRunIdOr(entry);
    const key = `${entry.id}::${runId}`;
    const slim: StepDurationEntry = {
      timestamp: entry.timestamp,
      status: entry.status,
      step: entry.step,
    };
    const bucket = runHistory.get(key);
    if (bucket) bucket.push(slim);
    else runHistory.set(key, [slim]);
  }
  const stepDurationsByRun = new Map<string, Record<string, number>>();
  for (const [key, rows] of runHistory) {
    stepDurationsByRun.set(key, computeStepDurations(rows));
  }

  const entriesByItem = new Map<string, TrackerEntry[]>();
  for (const entry of entries) {
    const bucket = entriesByItem.get(entry.id) ?? [];
    bucket.push(entry);
    entriesByItem.set(entry.id, bucket);
  }
  const timelinesByItem = new Map<string, Map<string, RunTimeline>>();
  for (const [itemId, rows] of entriesByItem) {
    timelinesByItem.set(itemId, buildRunTimelines(rows));
  }

  const failedItemIds = new Set(entries.filter((entry) => entry.status === "failed").map((entry) => entry.id));
  const screenshotCountByItem = countScreenshotsForItems(workflow, failedItemIds, date, dir);
  const enriched = entries.map((entry) => {
    const runId = getRunIdOr(entry);
    const key = `${entry.id}::${runId}`;
    let screenshotCount: number | undefined;
    if (entry.status === "failed") {
      screenshotCount = screenshotCountByItem.get(entry.id) ?? 0;
    }

    const timeline = timelinesByItem.get(entry.id)?.get(runId);
    const logFirstTs = logFirst.get(key);
    const logLastTs = logLast.get(key);
    const spanFirstTs = pickEarlier(logFirstTs, timeline?.earliestTrackerTs);
    const spanLastTs = pickLater(logLastTs, timeline?.latestTrackerTs);

    return {
      ...entry,
      runId,
      firstLogTs: spanFirstTs,
      lastLogTs: spanLastTs,
      lastLogMessage: logLastMsg.get(key),
      stepDurations: stepDurationsByRun.get(key) ?? {},
      ...(timeline ? { runOrdinal: timeline.ordinal } : {}),
      ...(screenshotCount !== undefined ? { screenshotCount } : {}),
    };
  });

  const targetDate = date || today;
  const { workflows, wfCounts, failureCounts } = getCrossWorkflowCounts(targetDate, dir);

  return { entries: enriched, workflows, wfCounts, failureCounts };
}
