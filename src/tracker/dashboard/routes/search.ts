import type { DashboardRoute } from "../route-types.js";
import {
  listDatesForWorkflow,
  listWorkflows,
  readEntriesForDate,
} from "../../jsonl.js";
import { buildSearchHandler } from "../search.js";
import { buildPreviewInboxHandler } from "../preview-inbox.js";
import { buildFailuresHandler } from "../failures.js";
import { buildSelectorWarningsHandler } from "../selector-warnings.js";

export function createSearchRoutes(): DashboardRoute {
  return async (_req, res, url, ctx) => {
    const { dir } = ctx;

    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const wf = url.searchParams.get("workflow") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const daysRaw = url.searchParams.get("days");
      const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
      const parsedDays = daysRaw ? Number.parseInt(daysRaw, 10) : NaN;
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
      const days = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 30;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      try {
        const handler = buildSearchHandler({
          listWorkflows,
          listDates: listDatesForWorkflow,
          readEntriesForDate,
        });
        const rows = handler(q, { workflow: wf, limit, days });
        res.end(JSON.stringify(rows));
      } catch {
        res.end(JSON.stringify([]));
      }
      return true;
    }

    if (url.pathname === "/api/preview-inbox") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      try {
        const handler = buildPreviewInboxHandler({
          listWorkflows: () => listWorkflows(dir),
          listDates: (wf) => listDatesForWorkflow(wf, dir),
          readEntriesForDate: (wf, date) => readEntriesForDate(wf, date, dir),
        });
        const rows = handler();
        res.end(JSON.stringify(rows));
      } catch {
        res.end(JSON.stringify([]));
      }
      return true;
    }

    if (url.pathname === "/api/failures") {
      const dateParam = url.searchParams.get("date");
      if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Missing or invalid `date` query param (expected YYYY-MM-DD)" }));
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      try {
        const handler = buildFailuresHandler({
          listWorkflows: () => listWorkflows(dir),
          readEntriesForDate: (wf, date) => readEntriesForDate(wf, date, dir),
        });
        const rows = handler({ date: dateParam });
        res.end(JSON.stringify(rows));
      } catch {
        res.end(JSON.stringify([]));
      }
      return true;
    }

    if (url.pathname === "/api/selector-warnings") {
      const daysParam = url.searchParams.get("days");
      const parsed = daysParam ? Number.parseInt(daysParam, 10) : 7;
      const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      try {
        const rows = buildSelectorWarningsHandler()(days);
        res.end(JSON.stringify(rows));
      } catch {
        res.end(JSON.stringify([]));
      }
      return true;
    }

    return false;
  };
}
