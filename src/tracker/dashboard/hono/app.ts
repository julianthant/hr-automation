import { Hono } from "hono";

import { log } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import type { DashboardHonoDeps } from "./context.js";
import { jsonResponse, preflightResponse } from "./responses.js";
import { registerBaseRoutes } from "./routes/base.js";
import { registerCaptureRoutes } from "./routes/capture.js";
import { registerDaemonStopRoute } from "./routes/daemon-stop.js";
import { registerEnqueueRoute } from "./routes/enqueue.js";
import { registerHubRoute } from "./routes/hub.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerOathUploadRoutes } from "./routes/oath-upload.js";
import { registerOcrRoutes } from "./routes/ocr.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerProjectionRoutes } from "./routes/projection.js";
import { registerScreenshotRoutes } from "./routes/screenshots.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerSharePointRoutes } from "./routes/sharepoint.js";
import { registerStaticRoutes } from "./routes/static.js";
import { registerTaskRoutes } from "./routes/tasks.js";

export type { DashboardHonoDeps } from "./context.js";

export function createDashboardHonoApp(deps: DashboardHonoDeps): Hono {
  const app = new Hono();

  app.options("*", () => preflightResponse());

  // Unhandled exceptions in route handlers must return a CORS-friendly JSON
  // 500 — Hono's default error response is plain-text without
  // Access-Control-Allow-Origin, which the browser blocks on cross-origin
  // requests (dashboard page on :5173/:3838 → upload listener on :3839),
  // surfacing as a misleading "Network error" in XHR.onerror instead of the
  // real status.
  app.onError((err, c) => {
    const message = errorMessage(err);
    log.warn(`[dashboard-api] ${c.req.method} ${c.req.path} threw: ${message}`);
    if (err instanceof Error && err.stack) {
      log.warn(err.stack);
    }
    return jsonResponse({ ok: false, error: message }, 500);
  });

  registerProjectionRoutes(app, deps);
  registerFileRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerBaseRoutes(app, deps);
  registerSearchRoutes(app, deps);
  registerScreenshotRoutes(app, deps);
  registerSharePointRoutes(app);
  registerEnqueueRoute(app, deps);
  registerDaemonStopRoute(app, deps);
  registerOpsRoutes(app, deps);
  registerOcrRoutes(app, deps);
  registerOathUploadRoutes(app, deps);
  registerCaptureRoutes(app, deps);
  registerHubRoute(app, deps);
  registerStaticRoutes(app, deps);

  return app;
}
