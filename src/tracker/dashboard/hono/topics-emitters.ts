import { readSessionEvents } from "../../../tracker/session-events.js";
import {
  dateLocal,
  readLogEntries,
  readLogEntriesForDate,
  readEntries,
  readEntriesForDate,
  type TrackerEntry,
} from "../../../tracker/jsonl.js";
import {
  mapLogRowToWire,
  mapRunEventRowToWire,
  queryEntriesPayload,
  querySessionEventsForRun,
  selectLogsForRun,
  selectRunEventsForRun,
} from "../../../tracker/state/queries.js";
import { buildJsonlEventsPayload } from "./routes/entries-payload.js";
import {
  filterLiveSessionState,
  filterEventsForRun,
  rebuildSessionState,
  resolveInstanceForRun,
} from "../session-state.js";
import { log } from "../../../utils/log.js";
import { getDefaultWorkflow, getProjectionDb } from "./context.js";
import { ttlMemoize } from "./memo.js";
import { registerTopic, type TopicEmitter } from "./topics.js";
import { captureStore, serializeCaptureSession } from "../capture-state.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

async function readSessionEventsTolerant(dir: string) {
  try {
    return readSessionEvents(dir);
  } catch (err) {
    log.debug(`session events read failed: ${err instanceof Error ? err.message : String(err)}`);
    // Transient read failures recover on the next tick.
    return [];
  }
}

function resolveWorkflow(
  params: { workflow?: string },
  deps: Parameters<TopicEmitter<Record<string, never>>>[2],
): string {
  return params.workflow && params.workflow.length > 0
    ? params.workflow
    : getDefaultWorkflow(deps);
}

function makeDeltaTopic<T>(
  fetcher: () => T[] | Promise<T[]>,
  send: (data: T[]) => void,
  intervalMs: number,
): () => void {
  let sentCount = 0;
  let firstTick = true;

  const tick = async () => {
    const events = await fetcher();
    if (firstTick) {
      send(events);
      sentCount = events.length;
      firstTick = false;
    } else {
      if (events.length < sentCount) {
        sentCount = 0;
      }
      if (events.length > sentCount) {
        send(events.slice(sentCount));
        sentCount = events.length;
      }
    }
  };

  void tick();
  const interval = setInterval(() => void tick(), intervalMs);
  interval.unref?.();
  return () => clearInterval(interval);
}

// ── sessions state cache ──────────────────────────────────────────────────────

const SESSION_STATE_TTL_MS = 1_000;
/**
 * 1s TTL cache around `rebuildSessionState`. Without caching, every 1 Hz SSE
 * tick × N connected clients would re-aggregate all dated
 * `sessions-YYYY-MM-DD.jsonl` files on every call.
 */
const getCachedSessionState = ttlMemoize(
  SESSION_STATE_TTL_MS,
  (dir: string) => dir,
  rebuildSessionState,
);

export function __resetSessionStateCacheForTests(): void {
  getCachedSessionState.reset();
}

// ── entries payload cache ─────────────────────────────────────────────────────

const ENTRIES_PAYLOAD_TTL_MS = 1_000;
/**
 * 1s TTL cache around `queryEntriesPayload`. Without caching, every 1 Hz SSE
 * tick × N connected clients would each run the full date-wide projection query.
 */
const getCachedEntriesPayload = ttlMemoize(
  ENTRIES_PAYLOAD_TTL_MS,
  (
    _stateDb: Parameters<typeof queryEntriesPayload>[0],
    dir: string,
    workflow: string,
    date: string,
  ) => `${dir}|${workflow}|${date}`,
  (stateDb, _dir, workflow, date) =>
    queryEntriesPayload(stateDb, { workflow, date }),
);

export function __resetEntriesPayloadCacheForTests(): void {
  getCachedEntriesPayload.reset();
}

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
  const workflow = resolveWorkflow(params, deps);
  const date = params.date ?? "";
  const today = dateLocal();

  const tick = () => {
    const stateDb = getProjectionDb(deps);
    if (stateDb) {
      try {
        send(getCachedEntriesPayload(stateDb, deps.dir, workflow, date || today));
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
  const workflow = resolveWorkflow(params, deps);
  const itemId = params.id ?? "";
  const runId = params.runId ?? "";
  const date = params.date ?? "";
  const today = dateLocal();

  return makeDeltaTopic(() => {
    if (deps.projectionReady && deps.stateDb && runId) {
      try {
        return selectLogsForRun(deps.stateDb, {
          workflow,
          trackerDate: date || today,
          itemId,
          runId,
        }).flatMap((row) => { const e = mapLogRowToWire(row); return e ? [e] : []; });
      } catch (err) {
        log.warn(
          `logs SQLite query failed (workflow=${workflow}, itemId=${itemId}, runId=${runId}): ${err instanceof Error ? err.message : String(err)} — falling back to JSONL`,
        );
      }
    }
    let entries = date && date !== today
      ? readLogEntriesForDate(workflow, itemId || undefined, date, deps.dir)
      : readLogEntries(workflow, itemId || undefined, deps.dir);
    if (runId) {
      entries = entries.filter((entry) =>
        entry.runId ? entry.runId === runId : runId.endsWith("#1"),
      );
    }
    return entries;
  }, send, 500);
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
  id?: string;
  itemId?: string;
  runId?: string;
  date?: string;
}> = (params, send, deps) => {
  const workflow = resolveWorkflow(params, deps);
  const itemId = params.id ?? params.itemId ?? "";
  const requestedRunId = params.runId ?? "";
  const date = params.date ?? "";
  const today = dateLocal();

  return makeDeltaTopic(async () => {
    let trackerEntries: TrackerEntry[] = [];
    let usedTrackerSqlite = deps.projectionReady && deps.stateDb !== undefined;
    if (deps.projectionReady && deps.stateDb) {
      try {
        trackerEntries = selectRunEventsForRun(deps.stateDb, {
          workflow,
          trackerDate: date || today,
          ...(itemId ? { itemId } : {}),
          runId: requestedRunId,
        }).flatMap((row) => { const e = mapRunEventRowToWire(row); return e ? [e] : []; });
      } catch (err) {
        usedTrackerSqlite = false;
        log.warn(
          `run-events tracker SQLite query failed (workflow=${workflow}, runId=${requestedRunId}): ${err instanceof Error ? err.message : String(err)} — falling back to JSONL`,
        );
      }
    }
    if (!usedTrackerSqlite) {
      try {
        trackerEntries = readTrackerEntriesForRunEvents(workflow, date, today, deps.dir);
      } catch {
        // Tracker read failure only disables workflowInstance fallback for this tick.
      }
    }
    let allEvents: Awaited<ReturnType<typeof readSessionEventsTolerant>> = [];
    let usedSqlite = deps.projectionReady && deps.stateDb !== undefined;
    if (deps.projectionReady && deps.stateDb) {
      // Use `resolveInstanceForRun` (not `Array.find`) so we keep walking past
      // pending rows that lack `data.instance` and pick up the first row that
      // actually carries the batch instance. Without this, the SQLite query
      // runs without `workflowInstance` and batch-scope events (workflow_start,
      // browser_launch, auth_*, duo_*) — which carry no runId — never enter
      // `allEvents` for `filterEventsForRun` to attribute.
      const wfInstance = resolveInstanceForRun(trackerEntries, requestedRunId);
      try {
        const sqliteEvents = querySessionEventsForRun(deps.stateDb, {
          runId: requestedRunId,
          ...(wfInstance ? { workflowInstance: wfInstance } : {}),
        });
        allEvents = sqliteEvents;
      } catch (err) {
        usedSqlite = false;
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
    return filtered;
  }, send, 500);
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
