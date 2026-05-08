import type { Hono } from "hono";

import { type DashboardHonoDeps } from "../context.js";
import { jsonResponse } from "../responses.js";
import { sseResponse } from "../sse.js";
import {
  telegramTopic,
  entriesTopic,
  sessionsTopic,
  logsTopic,
  runEventsTopic,
  captureSessionsTopic,
  daemonLogTopic,
  activeDaemonLogWatchers as _activeDaemonLogWatchers,
  activeCaptureSseSubscribers as _activeCaptureSseSubscribers,
} from "../topics-emitters.js";

export function getActiveHonoDaemonLogWatcherCountForTests(): number {
  // Read the live ESM binding from topics-emitters.
  return _activeDaemonLogWatchers;
}

export function getActiveHonoCaptureSseSubscriberCountForTests(): number {
  // Read the live ESM binding from topics-emitters.
  return _activeCaptureSseSubscribers;
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
    // Preserve the legacy HTTP 400 short-circuit for invalid pid — the legacy
    // route returns a JSON 400, not an SSE error envelope. Callers that hit
    // this route directly still get the HTTP-level error. The hub's daemonLogTopic
    // emitter handles invalid pids differently (SSE error envelope, hub stays open).
    const pid = Number.parseInt(c.req.query("pid") ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return jsonResponse({ ok: false, error: "valid pid query param required" }, 400);
    }
    return sseResponse((send) => daemonLogTopic({ pid }, send, deps));
  });

  app.get("/api/capture/sessions/stream", () => {
    return sseResponse((send) => captureSessionsTopic({}, send, deps));
  });
}
