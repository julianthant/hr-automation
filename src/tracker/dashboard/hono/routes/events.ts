import { createReadStream, readFileSync, statSync, unwatchFile, watchFile } from "node:fs";
import type { Hono } from "hono";

import {
  dateLocal,
  listWorkflows,
  readEntries,
  readEntriesForDate,
  readLogEntries,
  readLogEntriesForDate,
  type TrackerEntry,
} from "../../../jsonl.js";
import {
  readSessionEvents,
  type SessionEvent,
} from "../../../session-events.js";
import { queryEntriesPayload, querySessionEventsForRun } from "../../../state/queries.js";
import { resolveDaemonLogPath } from "../../ops/index.js";
import {
  buildRunTimelines,
  computeStepDurations,
  pickEarlier,
  pickLater,
  type RunTimeline,
  type StepDurationEntry,
} from "../../run-timelines.js";
import { filterEventsForRun, filterLiveSessionState, rebuildSessionState } from "../../session-state.js";
import { isResolvedPrepEntry } from "../../prep-rows.js";
import { computeFailureCounts } from "../../failures.js";
import { buildScreenshotsHandler } from "../../screenshots.js";
import {
  captureStore,
  serializeCaptureSession,
} from "../../capture-state.js";
import { log } from "../../../../utils/log.js";
import { getDefaultWorkflow, type DashboardHonoDeps } from "../context.js";
import { jsonResponse } from "../responses.js";
import { sseResponse } from "../sse.js";

let activeDaemonLogWatchers = 0;
let activeCaptureSseSubscribers = 0;

export function getActiveHonoDaemonLogWatcherCountForTests(): number {
  return activeDaemonLogWatchers;
}

export function getActiveHonoCaptureSseSubscriberCountForTests(): number {
  return activeCaptureSseSubscribers;
}

interface CrossWorkflowCountsCache {
  workflows: string[];
  wfCounts: Record<string, number>;
  failureCounts: Record<string, number>;
  computedAt: number;
  key: string;
}

let countsCache: CrossWorkflowCountsCache | null = null;
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
function getCrossWorkflowCounts(
  targetDate: string,
  dir: string,
): { workflows: string[]; wfCounts: Record<string, number>; failureCounts: Record<string, number> } {
  const key = `${dir}::${targetDate}`;
  const now = Date.now();
  if (
    countsCache &&
    countsCache.key === key &&
    now - countsCache.computedAt < CROSS_WORKFLOW_COUNTS_TTL_MS
  ) {
    return {
      workflows: countsCache.workflows,
      wfCounts: countsCache.wfCounts,
      failureCounts: countsCache.failureCounts,
    };
  }
  const workflows = listWorkflows(dir);
  const wfCounts: Record<string, number> = {};
  const failureCounts: Record<string, number> = {};
  for (const wf of workflows) {
    const all = readEntriesForDate(wf, targetDate, dir);
    const latestById = new Map<string, TrackerEntry>();
    for (const entry of all) {
      const prev = latestById.get(entry.id);
      if (!prev || prev.timestamp <= entry.timestamp) latestById.set(entry.id, entry);
    }
    let count = 0;
    for (const entry of latestById.values()) {
      if (isResolvedPrepEntry(entry)) continue;
      count++;
    }
    wfCounts[wf] = count;
    const failures = computeFailureCounts(all);
    if (failures > 0) failureCounts[wf] = failures;
  }
  countsCache = { workflows, wfCounts, failureCounts, computedAt: now, key };
  return { workflows, wfCounts, failureCounts };
}

export function __resetCrossWorkflowCountsCacheForTests(): void {
  countsCache = null;
}

const SESSION_STATE_TTL_MS = 1_000;
let sessionStateCache:
  | { state: ReturnType<typeof rebuildSessionState>; computedAt: number; key: string }
  | null = null;

/**
 * 1s TTL cache around `rebuildSessionState` — shared across all connected
 * SSE clients of `/events/sessions` (and any other endpoint that wants the
 * current session aggregate). Without this, every SSE tick (1 Hz × N tabs)
 * re-aggregates every dated `sessions-YYYY-MM-DD.jsonl` file via uncached
 * `readSessionEvents`. With 5 tabs × 30 retained day-files that's ~150 sync
 * file reads/sec on a quiet dashboard.
 *
 * Mirrors the `getCrossWorkflowCounts` pattern: module-level cache keyed by
 * `dir`, TTL matches SSE cadence so within any second the heavy aggregation
 * runs at most once across all connected clients.
 */
function getCachedSessionState(dir: string): ReturnType<typeof rebuildSessionState> {
  const key = dir;
  const now = Date.now();
  if (
    sessionStateCache &&
    sessionStateCache.key === key &&
    now - sessionStateCache.computedAt < SESSION_STATE_TTL_MS
  ) {
    return sessionStateCache.state;
  }
  const state = rebuildSessionState(dir);
  sessionStateCache = { state, computedAt: now, key };
  return state;
}

export function __resetSessionStateCacheForTests(): void {
  sessionStateCache = null;
}

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

async function readSessionEventsTolerant(dir: string): Promise<SessionEvent[]> {
  try {
    return readSessionEvents(dir);
  } catch {
    // Transient read failures recover on the next tick.
    return [];
  }
}

function buildJsonlEventsPayload(
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
    const runId = entry.runId || `${entry.id}#1`;
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

  const screenshotCountByItem = new Map<string, number>();
  const screenshotsHandler = buildScreenshotsHandler();
  const enriched = entries.map((entry) => {
    const runId = entry.runId || `${entry.id}#1`;
    const key = `${entry.id}::${runId}`;
    let screenshotCount: number | undefined;
    if (entry.status === "failed") {
      const screenshotKey = `${entry.workflow}::${entry.id}`;
      let count = screenshotCountByItem.get(screenshotKey);
      if (count === undefined) {
        try {
          count = screenshotsHandler(entry.workflow, entry.id).length;
        } catch {
          count = 0;
        }
        screenshotCountByItem.set(screenshotKey, count);
      }
      screenshotCount = count;
    }

    const timeline = timelinesByItem.get(entry.id)?.get(runId);
    const logFirstTs = logFirst.get(key);
    const logLastTs = logLast.get(key);
    const spanFirstTs = pickEarlier(logFirstTs, timeline?.earliestTrackerTs);
    const spanLastTs = pickLater(logLastTs, timeline?.latestTrackerTs);

    return {
      ...entry,
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

export function registerEventRoutes(app: Hono, deps: DashboardHonoDeps): void {
  app.get("/events/logs", (c) => {
    const workflow = c.req.query("workflow") ?? getDefaultWorkflow(deps);
    const itemId = c.req.query("id") ?? "";
    const runId = c.req.query("runId") ?? "";
    const date = c.req.query("date") ?? "";
    const today = dateLocal();

    // E2E-TEMP: SSE first-tick + delta logging for FE/BE sync verification
    log.e2e("sse:logs:open", { wf: workflow, id: itemId, runId, date });
    return sseResponse((send) => {
      let sentCount = 0;
      let firstTick = true;
      const tick = () => {
        let entries = date && date !== today
          ? readLogEntriesForDate(workflow, itemId || undefined, date, deps.dir)
          : readLogEntries(workflow, itemId || undefined, deps.dir);
        if (runId) {
          entries = entries.filter((entry) => entry.runId ? entry.runId === runId : runId.endsWith("#1"));
        }
        if (firstTick) {
          send(entries);
          // E2E-TEMP
          log.e2e("sse:logs:firstTick", { wf: workflow, id: itemId, runId, count: entries.length });
          sentCount = entries.length;
          firstTick = false;
        } else if (entries.length > sentCount) {
          const delta = entries.slice(sentCount);
          send(delta);
          // E2E-TEMP
          log.e2e("sse:logs:delta", { wf: workflow, id: itemId, runId, deltaCount: delta.length, total: entries.length });
          sentCount = entries.length;
        }
      };
      tick();
      const interval = setInterval(tick, 500);
      interval.unref?.();
      return () => {
        clearInterval(interval);
        // E2E-TEMP
        log.e2e("sse:logs:close", { wf: workflow, id: itemId, runId });
      };
    });
  });

  app.get("/events/run-events", (c) => {
    const workflow = c.req.query("workflow") ?? getDefaultWorkflow(deps);
    const requestedRunId = c.req.query("runId") ?? "";
    const date = c.req.query("date") ?? "";
    const today = dateLocal();

    // E2E-TEMP
    log.e2e("sse:run-events:open", { wf: workflow, runId: requestedRunId, date });
    return sseResponse((send) => {
      let sentCount = 0;
      let firstTick = true;
      const tick = async () => {
        let trackerEntries: TrackerEntry[] = [];
        try {
          trackerEntries = readTrackerEntriesForStream(workflow, date, today, deps.dir);
        } catch {
          // Tracker read failure only disables workflowInstance fallback for this tick.
        }
        let allEvents: SessionEvent[] = [];
        let usedSqlite = false;
        if (deps.projectionReady && deps.stateDb) {
          const trackerEntry = trackerEntries.find((e) => e.runId === requestedRunId);
          const wfInstance =
            typeof trackerEntry?.data?.instance === "string"
              ? trackerEntry.data.instance
              : undefined;
          try {
            const sqliteEvents = querySessionEventsForRun(deps.stateDb, {
              runId: requestedRunId,
              ...(wfInstance ? { workflowInstance: wfInstance } : {}),
            });
            // Treat zero rows as "projection not yet caught up" and fall back
            // to the rotation-aware JSONL aggregation. Mirrors the
            // /api/screenshots grouped handler's `rows.length > 0` guard.
            if (sqliteEvents.length > 0) {
              allEvents = sqliteEvents;
              usedSqlite = true;
            }
          } catch (err) {
            // SQLite read failure (DB locked, schema mid-migration, etc.) must
            // not silently empty the SSE stream. Log and fall through to the
            // JSONL path below.
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`run-events SQLite query failed (runId=${requestedRunId}): ${msg} — falling back to JSONL`);
          }
        }
        if (!usedSqlite) {
          allEvents = await readSessionEventsTolerant(deps.dir);
        }
        const filtered = filterEventsForRun(allEvents, trackerEntries, requestedRunId);
        if (firstTick) {
          send(filtered);
          // E2E-TEMP
          log.e2e("sse:run-events:firstTick", { wf: workflow, runId: requestedRunId, count: filtered.length });
          sentCount = filtered.length;
          firstTick = false;
        } else if (filtered.length > sentCount) {
          const delta = filtered.slice(sentCount);
          send(delta);
          // E2E-TEMP
          log.e2e("sse:run-events:delta", { wf: workflow, runId: requestedRunId, deltaCount: delta.length, total: filtered.length });
          sentCount = filtered.length;
        }
      };
      void tick();
      const interval = setInterval(() => void tick(), 500);
      interval.unref?.();
      return () => {
        clearInterval(interval);
        // E2E-TEMP
        log.e2e("sse:run-events:close", { wf: workflow, runId: requestedRunId });
      };
    });
  });

  app.get("/events/telegram", () => {
    return sseResponse((send) => {
      let sentCount = 0;
      let firstTick = true;
      const tick = async () => {
        const events = (await readSessionEventsTolerant(deps.dir)).filter((event) => event.type === "telegram_sent");
        if (firstTick) {
          send(events);
          sentCount = events.length;
          firstTick = false;
        } else if (events.length > sentCount) {
          send(events.slice(sentCount));
          sentCount = events.length;
        }
      };
      void tick();
      const interval = setInterval(() => void tick(), 1_000);
      interval.unref?.();
      return () => clearInterval(interval);
    });
  });

  app.get("/events/sessions", () => {
    return sseResponse((send) => {
      const tick = () => send(filterLiveSessionState(getCachedSessionState(deps.dir)));
      tick();
      const interval = setInterval(tick, 1_000);
      interval.unref?.();
      return () => clearInterval(interval);
    });
  });

  app.get("/events", (c) => {
    const workflow = c.req.query("workflow") ?? getDefaultWorkflow(deps);
    const date = c.req.query("date") ?? "";
    const today = dateLocal();

    return sseResponse((send) => {
      const tick = () => {
        if (deps.projectionReady && deps.stateDb) {
          try {
            send(queryEntriesPayload(deps.stateDb, { workflow, date: date || today }));
            return;
          } catch (err) {
            log.warn(`SQLite /events fallback to JSONL: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        send(buildJsonlEventsPayload(workflow, date, today, deps.dir));
      };
      tick();
      const interval = setInterval(tick, 1_000);
      interval.unref?.();
      return () => clearInterval(interval);
    });
  });

  app.get("/events/daemon-log", async (c) => {
    const pid = Number.parseInt(c.req.query("pid") ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return jsonResponse({ ok: false, error: "valid pid query param required" }, 400);
    }
    const path = await resolveDaemonLogPath(pid, deps.dir);
    if (!path) return jsonResponse({ ok: false, error: "no log file for that pid" }, 404);

    return sseResponse((send) => {
      let bytesSent = 0;
      try {
        const stat = statSync(path);
        const tailBytes = Math.min(stat.size, 4096);
        const startAt = Math.max(0, stat.size - tailBytes);
        const tail = readFileSync(path).subarray(startAt).toString("utf-8");
        for (const line of tail.split("\n")) {
          if (!line) continue;
          send({ line, ts: new Date().toISOString() });
        }
        bytesSent = stat.size;
      } catch {
        // Empty or deleted log files recover if watchFile sees new content.
      }

      const onChange = (curr: { size: number }): void => {
        if (curr.size <= bytesSent) return;
        const stream = createReadStream(path, { start: bytesSent, end: curr.size - 1 });
        let buffered = "";
        stream.on("data", (chunk) => {
          buffered += String(chunk);
        });
        stream.on("end", () => {
          for (const line of buffered.split("\n")) {
            if (!line) continue;
            send({ line, ts: new Date().toISOString() });
          }
          bytesSent = curr.size;
        });
      };

      watchFile(path, { interval: 500 }, onChange);
      activeDaemonLogWatchers += 1;
      return () => {
        unwatchFile(path, onChange);
        activeDaemonLogWatchers = Math.max(0, activeDaemonLogWatchers - 1);
      };
    });
  });

  app.get("/api/capture/sessions/stream", () => {
    return sseResponse((send) => {
      send({ sessions: captureStore.listAll().map(serializeCaptureSession) }, "session-list");
      const unsubscribe = captureStore.subscribe((event) => send(event, "session-event"));
      activeCaptureSseSubscribers += 1;
      const heartbeat = setInterval(() => send({ ts: Date.now() }, "heartbeat"), 15_000);
      heartbeat.unref?.();
      return () => {
        clearInterval(heartbeat);
        unsubscribe();
        activeCaptureSseSubscribers = Math.max(0, activeCaptureSseSubscribers - 1);
      };
    });
  });
}
