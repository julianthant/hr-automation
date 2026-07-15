import { Hono } from "hono";

import { log } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import type { DashboardHonoDeps } from "./context.js";
import { jsonResponse, preflightResponse } from "./responses.js";
import { registerBaseRoutes } from "./routes/base.js";
import { registerCaptureRoutes } from "./routes/capture.js";
import { registerDaemonStopRoute } from "./routes/daemon-stop.js";
import { registerDaemonStopInstanceRoute } from "./routes/daemon-stop-instance.js";
import { registerEnqueueRoute } from "./routes/enqueue.js";
import { registerHubRoute } from "./routes/hub.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerOathUploadRoutes } from "./routes/oath-upload.js";
import { registerOcrRoutes } from "./routes/ocr.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerProjectionRoutes } from "./routes/projection.js";
import { registerScreenshotRoutes } from "./routes/screenshots.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSharePointRoutes } from "./routes/sharepoint.js";
import { registerStaticRoutes } from "./routes/static.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerWorkflowPresentationRoutes } from "./routes/workflow-presentation.js";
import { registerWorkflowDesignRoutes } from "./routes/workflow-design.js";
import { registerAiAssistRoutes } from "./routes/ai-assist.js";
import { isPublicCaptureRequestAllowed } from "./public-scope.js";
import {
  dashboardAccessMiddleware,
  publicCaptureCorsMiddleware,
  registerOperatorSessionRoute,
} from "./security.js";

export type { DashboardHonoDeps } from "./context.js";

export function createDashboardHonoApp(deps: DashboardHonoDeps): Hono {
  const app = new Hono();

  if (deps.accessPolicy) {
    app.use("*", dashboardAccessMiddleware(deps.accessPolicy));
    registerOperatorSessionRoute(app, deps.accessPolicy);
  } else {
    app.options("*", () => preflightResponse());
    app.use("*", async (_c, next) => next());
    app.get("/api/operator/session", () =>
      jsonResponse({ ok: false, error: "Operator session is available only on a running dashboard" }, 503));
  }

  // Unhandled exceptions stay structured; the boundary middleware applies
  // origin-specific CORS after the route returns.
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
  registerWorkflowPresentationRoutes(app, deps);
  registerWorkflowDesignRoutes(app, deps);
  registerAiAssistRoutes(app);
  registerSettingsRoutes(app, deps);
  registerSearchRoutes(app, deps);
  registerScreenshotRoutes(app, deps);
  registerSharePointRoutes(app);
  registerEnqueueRoute(app, deps);
  registerDaemonStopRoute(app, deps);
  registerDaemonStopInstanceRoute(app, deps);
  registerOpsRoutes(app, deps);
  registerOcrRoutes(app, deps);
  registerOathUploadRoutes(app, deps);
  registerCaptureRoutes(app, deps);
  registerHubRoute(app, deps);
  registerStaticRoutes(app, deps);

  return app;
}

/** Dedicated phone listener: no dashboard APIs, SSE, files, settings, or SPA. */
export function createPublicCaptureHonoApp(deps: DashboardHonoDeps): Hono {
  const app = new Hono();
  app.use("*", publicCaptureCorsMiddleware(process.env.CAPTURE_PUBLIC_URL));
  app.use("*", async (c, next) => {
    if (!isPublicCaptureRequestAllowed(c.req.method, c.req.path)) {
      return c.text("Not found", 404);
    }
    return next();
  });
  app.onError((err, c) => {
    const message = errorMessage(err);
    log.warn(`[capture-api] ${c.req.method} ${c.req.path} threw: ${message}`);
    return jsonResponse({ ok: false, error: message }, 500);
  });
  registerCaptureRoutes(app, deps);
  return app;
}
