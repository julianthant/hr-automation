import { createReadStream, readFileSync, statSync, unwatchFile, watchFile } from "node:fs";
import type { Hono } from "hono";

import {
  dateLocal,
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
import { querySessionEventsForRun } from "../../../state/queries.js";
import { resolveDaemonLogPath } from "../../ops/index.js";
import { filterEventsForRun } from "../../session-state.js";
import {
  captureStore,
  serializeCaptureSession,
} from "../../capture-state.js";
import { log } from "../../../../utils/log.js";
import { getDefaultWorkflow, type DashboardHonoDeps } from "../context.js";
import { jsonResponse } from "../responses.js";
import { sseResponse } from "../sse.js";
import { telegramTopic, entriesTopic, sessionsTopic } from "../topics-emitters.js";

let activeDaemonLogWatchers = 0;
let activeCaptureSseSubscribers = 0;

export function getActiveHonoDaemonLogWatcherCountForTests(): number {
  return activeDaemonLogWatchers;
}

export function getActiveHonoCaptureSseSubscriberCountForTests(): number {
  return activeCaptureSseSubscribers;
}

// Re-export so existing callers of __resetCrossWorkflowCountsCacheForTests from
// events.ts continue to work without import changes in test files.
export { __resetCrossWorkflowCountsCacheForTests } from "./entries-payload.js";

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
    return sseResponse((send) => telegramTopic({}, send, deps));
  });

  app.get("/events/sessions", () => {
    return sseResponse((send) => sessionsTopic({}, send, deps));
  });

  app.get("/events", (c) => {
    const workflow = c.req.query("workflow");
    const date = c.req.query("date");
    return sseResponse((send) => entriesTopic({ workflow, date }, send, deps));
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
