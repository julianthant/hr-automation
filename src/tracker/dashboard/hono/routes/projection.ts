import type { Hono } from "hono";

import { dateLocal } from "../../../jsonl.js";
import { queryEntriesPayload, queryProjectionHealth, queryRunsForItem } from "../../../state/queries.js";
import { getProjectionDb, type DashboardHonoDeps } from "../context.js";
import { jsonResponse } from "../responses.js";

export function registerProjectionRoutes(app: Hono, deps: DashboardHonoDeps): void {
  app.get("/api/v2/projection/health", () => {
    const stateDb = getProjectionDb(deps);
    if (!stateDb) {
      return jsonResponse({ ok: false, error: "projection not ready" }, 503);
    }
    return jsonResponse(queryProjectionHealth(stateDb, deps.dir));
  });

  app.get("/api/v2/entries", (c) => {
    const stateDb = getProjectionDb(deps);
    if (!stateDb) {
      return jsonResponse({ ok: false, error: "projection not ready" }, 503);
    }
    const workflow = c.req.query("workflow") ?? "onboarding";
    const date = c.req.query("date") ?? dateLocal();
    return jsonResponse(queryEntriesPayload(stateDb, { workflow, date }));
  });

  app.get("/api/v2/runs", (c) => {
    const stateDb = getProjectionDb(deps);
    if (!stateDb) {
      return jsonResponse({ ok: false, error: "projection not ready" }, 503);
    }
    const workflow = c.req.query("workflow") ?? "";
    const itemId = c.req.query("id") ?? "";
    const date = c.req.query("date") ?? dateLocal();
    if (!workflow || !itemId) {
      return jsonResponse({ ok: false, error: "workflow and id are required" }, 400);
    }
    return jsonResponse(queryRunsForItem(stateDb, { workflow, itemId, date }));
  });
}
