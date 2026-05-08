import type { Hono } from "hono";

import { type DashboardHonoDeps } from "../context.js";
import { activeCaptureSseSubscribers as _activeCaptureSseSubscribers } from "../topics-emitters.js";

export function getActiveHonoCaptureSseSubscriberCountForTests(): number {
  // Read the live ESM binding from topics-emitters.
  return _activeCaptureSseSubscribers;
}

// Re-export so existing callers of __resetCrossWorkflowCountsCacheForTests from
// events.ts continue to work without import changes in test files.
export { __resetCrossWorkflowCountsCacheForTests } from "./entries-payload.js";

export function registerEventRoutes(_app: Hono, _deps: DashboardHonoDeps): void {
  // Legacy per-topic SSE endpoints removed 2026-05-08.
  // All SSE is now served exclusively via /events/hub (see routes/hub.ts).
  // Topic emitter implementations remain in topics-emitters.ts.
}
