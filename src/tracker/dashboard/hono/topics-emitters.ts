import { readSessionEvents, type SessionEvent } from "../../../tracker/session-events.js";
import {
  dateLocal,
  type TrackerEntry,
} from "../../../tracker/jsonl.js";
import {
  readVisibleEntries,
  readVisibleEntriesForDate,
  readVisibleLogEntries,
  readVisibleLogEntriesForDate,
  isDeletedRun,
} from "../../../tracker/deletions/visible.js";
import {
  mapLogRowToWire,
  mapRunEventRowToWire,
  queryEntriesPayload,
  querySessionEventsForRun,
  selectChildRunEntriesForCoordinator,
  selectLogsForRun,
  selectRunEventsForRun,
} from "../../../tracker/state/queries.js";
import { buildJsonlEventsPayload } from "./routes/entries-payload.js";
import {
  filterLiveSessionState,
  filterEventsForRun,
  getEventSortKey,
  rebuildSessionState,
  resolveInstanceForRun,
  resolveInstanceForOperationCoordinator,
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

/**
 * Polls `fetcher` and streams only the entries the client has not seen yet.
 *
 * The first tick sends the full current array (the client REPLACES on its first
 * batch); every later tick sends only the never-before-sent entries (the client
 * APPENDS). Passing `keyOf` tracks sent entries by a STABLE IDENTITY KEY rather
 * than by array position — this is resilient to mid-array insertions,
 * reordering, and projection lag, which a positional `slice(sentCount)` would
 * re-emit as a duplicated suffix (the source of the duplicated log/event tails).
 * Without `keyOf` the legacy positional delta is kept for any other caller.
 *
 * Within one subscription a sent key is never re-sent (the client only tolerates
 * a re-replace on a NEW subscription generation), so duplicate suppression holds
 * even across list shrink/reorder. The sent-keys set grows with the run; that is
 * bounded per-subscription (runs are finite, the client log window caps at 5000)
 * so no eviction is needed.
 */
export function makeDeltaTopic<T>(
  fetcher: () => T[] | Promise<T[]>,
  send: (data: T[]) => void,
  intervalMs: number,
  keyOf?: (entry: T) => string,
): () => void {
  let sentCount = 0;
  let firstTick = true;
  const sentKeys = new Set<string>();

  const tick = async () => {
    // Contained: a fetcher throw/reject must not become an unhandled
    // rejection (which would take the whole process down) — it skips this
    // tick and the next interval retries.
    let events: T[];
    try {
      events = await fetcher();
    } catch (err) {
      log.warn(`SSE delta tick failed: ${err instanceof Error ? err.message : String(err)} — retrying next tick`);
      return;
    }
    if (keyOf) {
      const fresh: T[] = [];
      for (const e of events) {
        const k = keyOf(e);
        if (sentKeys.has(k)) continue;
        sentKeys.add(k);
        fresh.push(e);
      }
      if (firstTick) { firstTick = false; send(events); return; } // client REPLACES on first batch (even if empty)
      if (fresh.length > 0) send(fresh);
      return;
    }
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

/**
 * Polls `fetcher` and sends the snapshot ONLY when its serialized form changed
 * since the last send. The 1 Hz snapshot topics (entries, sessions) used to
 * re-send the full payload every tick even when nothing changed — for an idle
 * dashboard that is the entire queue projection each second per client, and it
 * grows with the day's row count. The client's semantics are replace-on-message,
 * so suppressing identical payloads is invisible to it (state persists between
 * messages; `sseResponse`'s keep-alive comment covers proxy idle timeouts).
 *
 * A fetcher throw is contained to the tick (logged + retried next interval) so
 * one bad projection read can never kill the interval or the process.
 */
export function makeSnapshotTopic(
  fetcher: () => unknown,
  send: (data: unknown) => void,
  intervalMs: number,
  label: string,
): () => void {
  let lastSerialized: string | undefined;
  const tick = () => {
    try {
      const data = fetcher();
      const serialized = JSON.stringify(data);
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      send(data);
    } catch (err) {
      log.warn(`${label} SSE tick failed: ${err instanceof Error ? err.message : String(err)} — retrying next tick`);
    }
  };
  tick();
  const interval = setInterval(tick, intervalMs);
  interval.unref?.();
  return () => clearInterval(interval);
}

/**
 * Stable per-line identity for the `logs` topic. The wire `LogEntry` carries no
 * row id, so distinguish lines by item/run scope, timestamp, level, and message.
 * (Two byte-identical lines at the same ms collapse — the client already
 * collapses consecutive identical messages — but distinct lines never collide.)
 */
function logEntryKey(e: {
  itemId?: string;
  runId?: string;
  ts: string;
  level: string;
  message: string;
}): string {
  return [e.itemId ?? "", e.runId ?? "", e.ts, e.level, e.message].join("\u0000");
}

/**
 * Stable identity for a `runEvents` session event. Mirrors the disambiguators
 * `buildLogStreamItemKey` uses client-side (type, run/item scope, timestamp,
 * step/system/label) so genuinely distinct events never share a key.
 */
function runEventKey(e: SessionEvent): string {
  // step/label/kind exist only on the `screenshot` variant — they disambiguate
  // multiple shots within one run that share type+timestamp.
  const shot = e as SessionEvent & { step?: string | null; label?: string; kind?: string };
  const base = [e.type, e.runId ?? "", e.currentItemId ?? "", getEventSortKey(e), e.currentStep ?? "", e.system ?? "", e.sessionId ?? ""];
  const screenshotOnly = [shot.step ?? "", shot.label ?? "", shot.kind ?? ""];
  return [...base, ...screenshotOnly].join("\u0000");
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

  return makeSnapshotTopic(() => {
    const stateDb = getProjectionDb(deps);
    if (stateDb) {
      try {
        return getCachedEntriesPayload(stateDb, deps.dir, workflow, date || today);
      } catch (err) {
        log.warn(
          `SQLite /events fallback to JSONL: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return buildJsonlEventsPayload(workflow, date, today, deps.dir);
  }, send, 1_000, "entries");
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
  return makeSnapshotTopic(
    () => filterLiveSessionState(getCachedSessionState(deps.dir)),
    send,
    1_000,
    "sessions",
  );
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
      ? readVisibleLogEntriesForDate(workflow, itemId || undefined, date, deps.dir)
      : readVisibleLogEntries(workflow, itemId || undefined, deps.dir);
    if (runId) {
      entries = entries.filter((entry) =>
        entry.runId ? entry.runId === runId : runId.endsWith("#1"),
      );
    }
    return entries;
  }, send, 500, logEntryKey);
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
    ? readVisibleEntriesForDate(workflow, date, dir)
    : readVisibleEntries(workflow, dir);
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
    const trackerDate = date || today;
    if (requestedRunId && itemId && isDeletedRun(deps.dir, {
      workflow,
      trackerDate,
      itemId,
      runId: requestedRunId,
    })) return [];
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
        // Operation coordinator rows (archetype:"operation") have no data.instance
        // themselves — the daemon processes the member items, each carrying the
        // real data.instance via parentRunId. The coordinator-only query above
        // never returns member entries. Supplement with child rows so that
        // resolveInstanceForOperationCoordinator and filterEventsForRun can find
        // them (they search by parentRunId). This is a targeted, indexed lookup
        // only when the direct instance lookup misses, keeping the common path
        // (normal single/batch rows that carry data.instance directly) unchanged.
        if (
          requestedRunId &&
          resolveInstanceForRun(trackerEntries, requestedRunId) === undefined
        ) {
          const childEntries = selectChildRunEntriesForCoordinator(deps.stateDb, requestedRunId);
          if (childEntries.length > 0) {
            trackerEntries = [...trackerEntries, ...childEntries];
          }
        }
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
      // Resolve the workflowInstance for the requested run so the SQLite query
      // can fetch batch-scope events (workflow_start, browser_launch, auth_*,
      // duo_*, idle_signal) that carry no runId.
      //
      // For most runs, `resolveInstanceForRun` finds the instance directly on a
      // tracker row with `runId === requestedRunId`.
      //
      // Operation coordinator rows (archetype:"operation") are display-only
      // pending rows that have NO `data.instance` — the daemon processes the
      // member items, each of which carries the real `data.instance`. After the
      // child-entry supplement above, `trackerEntries` now contains both the
      // coordinator row AND its member rows, so `resolveInstanceForOperationCoordinator`
      // finds the instance via the child fallback path and `filterEventsForRun`
      // can include the daemon lifecycle events in the coordinator's window.
      const wfInstance =
        resolveInstanceForRun(trackerEntries, requestedRunId) ??
        resolveInstanceForOperationCoordinator(trackerEntries, requestedRunId);
      // Operation coordinator: its member rows were supplemented into
      // `trackerEntries` above. Pass their run ids so the coordinator timeline
      // can include each member's `item_start` (the consolidated event tracker)
      // — those events carry the member run id, not the coordinator's, so the
      // runId/instance clauses alone would drop them. Empty for normal runs.
      const memberRunIds = trackerEntries
        .filter((t) => t.parentRunId === requestedRunId && typeof t.runId === "string" && t.runId.length > 0)
        .map((t) => t.runId as string);
      try {
        const sqliteEvents = querySessionEventsForRun(deps.stateDb, {
          runId: requestedRunId,
          workflow,
          itemId,
          trackerDate,
          ...(wfInstance ? { workflowInstance: wfInstance } : {}),
          ...(memberRunIds.length > 0 ? { memberRunIds } : {}),
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
  }, send, 500, runEventKey);
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
