import { readSessionEvents } from "../../../tracker/session-events.js";
import { dateLocal } from "../../../tracker/jsonl.js";
import { queryEntriesPayload } from "../../../tracker/state/queries.js";
import { buildJsonlEventsPayload } from "./routes/entries-payload.js";
import { filterLiveSessionState, rebuildSessionState } from "../session-state.js";
import { log } from "../../../utils/log.js";
import { getDefaultWorkflow, type DashboardHonoDeps } from "./context.js";
import { registerTopic, type TopicEmitter } from "./topics.js";

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
