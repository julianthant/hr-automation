import { createReadStream, readFileSync, statSync, unwatchFile, watchFile } from "node:fs";
import type { Hono } from "hono";

import { resolveDaemonLogPath } from "../../ops/index.js";
import {
  captureStore,
  serializeCaptureSession,
} from "../../capture-state.js";
import { type DashboardHonoDeps } from "../context.js";
import { jsonResponse } from "../responses.js";
import { sseResponse } from "../sse.js";
import { telegramTopic, entriesTopic, sessionsTopic, logsTopic, runEventsTopic } from "../topics-emitters.js";

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

export function registerEventRoutes(app: Hono, deps: DashboardHonoDeps): void {
  app.get("/events/logs", (c) => {
    const workflow = c.req.query("workflow");
    const id = c.req.query("id");
    const runId = c.req.query("runId");
    const date = c.req.query("date");
    return sseResponse((send) => logsTopic({ workflow, id, runId, date }, send, deps));
  });

  app.get("/events/run-events", (c) => {
    const workflow = c.req.query("workflow");
    const runId = c.req.query("runId");
    const date = c.req.query("date");
    return sseResponse((send) => runEventsTopic({ workflow, runId, date }, send, deps));
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
