import { Hono } from "hono";

import type { DashboardHonoDeps } from "./context.js";
import { preflightResponse } from "./responses.js";
import { registerBaseRoutes } from "./routes/base.js";
import { registerCaptureRoutes } from "./routes/capture.js";
import { registerDaemonStopRoute } from "./routes/daemon-stop.js";
import { registerEnqueueRoute } from "./routes/enqueue.js";
import { registerEventRoutes } from "./routes/events.js";
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
  registerEventRoutes(app, deps);
  registerStaticRoutes(app, deps);

  return app;
}
