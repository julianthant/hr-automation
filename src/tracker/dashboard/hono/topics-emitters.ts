import { readSessionEvents } from "../../../tracker/session-events.js";
import {
  dateLocal,
  readLogEntries,
  readLogEntriesForDate,
  readEntries,
  readEntriesForDate,
  type TrackerEntry,
} from "../../../tracker/jsonl.js";
import { queryEntriesPayload, querySessionEventsForRun } from "../../../tracker/state/queries.js";
import { buildJsonlEventsPayload } from "./routes/entries-payload.js";
import { filterLiveSessionState, filterEventsForRun, rebuildSessionState } from "../session-state.js";
import { log } from "../../../utils/log.js";
import { getDefaultWorkflow } from "./context.js";
import { registerTopic, type TopicEmitter } from "./topics.js";
import { captureStore, serializeCaptureSession } from "../capture-state.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

async function readSessionEventsTolerant(dir: string) {
  try {
    return readSessionEvents(dir);
  } catch {
    // Transient read failures recover on the next tick.
    return [];
  }
}

// ── sessions state cache ──────────────────────────────────────────────────────

const SESSION_STATE_TTL_MS = 1_000;
let sessionStateCache:
  | { state: ReturnType<typeof rebuildSessionState>; computedAt: number; key: string }
  | null = null;

/**
 * 1s TTL cache around `rebuildSessionState`.  Mirrors the pattern used by
 * the legacy `/events/sessions` handler in routes/events.ts (now delegated
 * here).  Without caching, every 1 Hz SSE tick × N connected clients would
 * re-aggregate all dated `sessions-YYYY-MM-DD.jsonl` files on every call.
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

// ── telegram topic ────────────────────────────────────────────────────────────

/**
 * Polls `sessions.jsonl` every 1 second and sends delta batches of
 * `telegram_sent` events.  Emits the full list on first tick, then only
 * new events on subsequent ticks.
 *
 * Identical behavior to the legacy `/events/telegram` handler.
 */
export const telegramTopic: TopicEmitter<Record<string, never>> = (
  _params,
  send,
  deps,
) => {
  let sentCount = 0;
  let firstTick = true;

  const tick = async () => {
    const events = (await readSessionEventsTolerant(deps.dir)).filter(
      (event) => event.type === "telegram_sent",
    );
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
};

registerTopic("telegram", telegramTopic);

// ── entries topic ─────────────────────────────────────────────────────────────

/**
 * Polls tracker entries every 1 second and sends the full current payload.
 *
 * Uses the SQLite projection when available, falling back to JSONL.
 * `workflow` defaults to `getDefaultWorkflow(deps)` if absent or empty.
 * `date` is passed through; the tick uses `dateLocal()` for `today`.
 *
 * Identical behavior to the legacy `/events` handler.
 */
export const entriesTopic: TopicEmitter<{ workflow?: string; date?: string }> = (
  params,
  send,
  deps,
) => {
  const workflow =
    params.workflow && params.workflow.length > 0
      ? params.workflow
      : getDefaultWorkflow(deps);
  const date = params.date ?? "";
  const today = dateLocal();

  const tick = () => {
    if (deps.projectionReady && deps.stateDb) {
      try {
        send(queryEntriesPayload(deps.stateDb, { workflow, date: date || today }));
        return;
      } catch (err) {
        log.warn(
          `SQLite /events fallback to JSONL: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    send(buildJsonlEventsPayload(workflow, date, today, deps.dir));
  };

  tick();
  const interval = setInterval(tick, 1_000);
  interval.unref?.();
  return () => clearInterval(interval);
};

registerTopic("entries", entriesTopic);

// ── sessions topic ────────────────────────────────────────────────────────────

/**
 * Polls `SessionState` every 1 second and sends the filtered live state.
 *
 * Identical behavior to the legacy `/events/sessions` handler.
 */
export const sessionsTopic: TopicEmitter<Record<string, never>> = (
  _params,
  send,
  deps,
) => {
  const tick = () => send(filterLiveSessionState(getCachedSessionState(deps.dir)));

  tick();
  const interval = setInterval(tick, 1_000);
  interval.unref?.();
  return () => clearInterval(interval);
};

registerTopic("sessions", sessionsTopic);

// ── logs topic ────────────────────────────────────────────────────────────────

/**
 * Polls log entries every 500ms and sends first-tick full list then deltas.
 *
 * Params: `workflow`, `id` (item id), `runId`, `date`.  Defaults match the
 * legacy `/events/logs` handler: workflow → `getDefaultWorkflow(deps)`, others
 * default to `""`.
 *
 * Identical behavior to the legacy `/events/logs` handler.
 */
export const logsTopic: TopicEmitter<{
  workflow?: string;
  id?: string;
  runId?: string;
  date?: string;
}> = (params, send, deps) => {
  const workflow =
    params.workflow && params.workflow.length > 0
      ? params.workflow
      : getDefaultWorkflow(deps);
  const itemId = params.id ?? "";
  const runId = params.runId ?? "";
  const date = params.date ?? "";
  const today = dateLocal();

  // E2E-TEMP: SSE first-tick + delta logging for FE/BE sync verification
  log.e2e("sse:logs:open", { wf: workflow, id: itemId, runId, date });

  let sentCount = 0;
  let firstTick = true;

  const tick = () => {
    let entries = date && date !== today
      ? readLogEntriesForDate(workflow, itemId || undefined, date, deps.dir)
      : readLogEntries(workflow, itemId || undefined, deps.dir);
    if (runId) {
      entries = entries.filter((entry) =>
        entry.runId ? entry.runId === runId : runId.endsWith("#1"),
      );
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
};

registerTopic("logs", logsTopic);

// ── runEvents topic ───────────────────────────────────────────────────────────

function readTrackerEntriesForRunEvents(
  workflow: string,
  date: string,
  today: string,
  dir: string,
): TrackerEntry[] {
  return date && date !== today
    ? readEntriesForDate(workflow, date, dir)
    : readEntries(workflow, dir);
}

/**
 * Polls session events for a specific run every 500ms.  Uses the SQLite
 * projection when available (with `workflowInstance` fallback resolution);
 * falls back to JSONL aggregation.  Sends first-tick full list then deltas.
 *
 * Params: `workflow`, `runId`, `date`.
 *
 * Identical behavior to the legacy `/events/run-events` handler.
 */
export const runEventsTopic: TopicEmitter<{
  workflow?: string;
  runId?: string;
  date?: string;
}> = (params, send, deps) => {
  const workflow =
    params.workflow && params.workflow.length > 0
      ? params.workflow
      : getDefaultWorkflow(deps);
  const requestedRunId = params.runId ?? "";
  const date = params.date ?? "";
  const today = dateLocal();

  // E2E-TEMP
  log.e2e("sse:run-events:open", { wf: workflow, runId: requestedRunId, date });

  let sentCount = 0;
  let firstTick = true;

  const tick = async () => {
    let trackerEntries: TrackerEntry[] = [];
    try {
      trackerEntries = readTrackerEntriesForRunEvents(workflow, date, today, deps.dir);
    } catch {
      // Tracker read failure only disables workflowInstance fallback for this tick.
    }
    let allEvents: Awaited<ReturnType<typeof readSessionEventsTolerant>> = [];
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
        // to the rotation-aware JSONL aggregation.
        if (sqliteEvents.length > 0) {
          allEvents = sqliteEvents;
          usedSqlite = true;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          `run-events SQLite query failed (runId=${requestedRunId}): ${msg} — falling back to JSONL`,
        );
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
};

registerTopic("runEvents", runEventsTopic);

// ── captureSessions topic ─────────────────────────────────────────────────────

/**
 * Subscribes to capture session store changes and forwards events with typed
 * SSE event names: `"session-list"` on first tick, `"session-event"` on each
 * store mutation, and `"heartbeat"` every 15 seconds.
 *
 * Identical behavior to the legacy `/api/capture/sessions/stream` handler.
 * Preserves the `activeCaptureSseSubscribers` counter.
 */
export let activeCaptureSseSubscribers = 0;

export const captureSessionsTopic: TopicEmitter<Record<string, never>> = (
  _params,
  send,
) => {
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
};

registerTopic("captureSessions", captureSessionsTopic);
