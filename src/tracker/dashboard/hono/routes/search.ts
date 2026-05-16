import type { Hono } from "hono";

import {
  listDatesForWorkflow,
  listWorkflows,
  readEntriesForDate,
} from "../../../jsonl.js";
import { buildFailuresHandler } from "../../failures.js";
import { buildSearchHandler } from "../../search.js";
import { buildSelectorWarningsHandler } from "../../selector-warnings.js";
import type { DashboardHonoDeps } from "../context.js";
import { jsonResponse } from "../responses.js";

export function registerSearchRoutes(app: Hono, deps: DashboardHonoDeps): void {
  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    const workflow = c.req.query("workflow") ?? undefined;
    const limit = parsePositiveInt(c.req.query("limit"), 50);
    const days = parsePositiveInt(c.req.query("days"), 30);
    try {
      const handler = buildSearchHandler({
        listWorkflows: () => listWorkflows(deps.dir),
        listDates: (wf) => listDatesForWorkflow(wf, deps.dir),
        readEntriesForDate: (wf, date) => readEntriesForDate(wf, date, deps.dir),
      });
      return jsonResponse(handler(q, { workflow, limit, days }));
    } catch {
      return jsonResponse([]);
    }
  });

  app.get("/api/failures", (c) => {
    const date = c.req.query("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return jsonResponse({ error: "Missing or invalid `date` query param (expected YYYY-MM-DD)" }, 400);
    }
    try {
      const handler = buildFailuresHandler({
        listWorkflows: () => listWorkflows(deps.dir),
        readEntriesForDate: (workflow, trackerDate) => readEntriesForDate(workflow, trackerDate, deps.dir),
      });
      return jsonResponse(handler({ date }));
    } catch {
      return jsonResponse([]);
    }
  });

  app.get("/api/selector-warnings", (c) => {
    const days = parsePositiveInt(c.req.query("days"), 7);
    try {
      return jsonResponse(buildSelectorWarningsHandler(deps.dir, {
        projectionReady: deps.projectionReady === true,
        stateDb: deps.stateDb,
      })(days));
    } catch {
      return jsonResponse([]);
    }
  });
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
