import type { Hono } from "hono";

import { buildTaskDependenciesHandler } from "../../../tasks/http.js";
import type { DashboardHonoDeps } from "../context.js";
import { jsonResponse } from "../responses.js";

export function registerTaskRoutes(app: Hono, deps: DashboardHonoDeps): void {
  const taskDependenciesHandler = buildTaskDependenciesHandler({ trackerDir: deps.dir });

  app.get("/api/task-dependencies", async (c) => {
    const result = await taskDependenciesHandler({ parentRunId: c.req.query("parentRunId") });
    return jsonResponse(result.body, result.status);
  });
}
