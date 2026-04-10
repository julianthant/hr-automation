import { createServer, type Server } from "http";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  readEntries,
  readLogEntries,
  listWorkflows,
  listDatesForWorkflow,
  readEntriesForDate,
  readLogEntriesForDate,
  readRunsForId,
  cleanOldTrackerFiles,
} from "./jsonl.js";
import { log } from "../utils/log.js";

// Resolve path to built dashboard HTML (vite-plugin-singlefile output)
const DASHBOARD_HTML_PATH = join(
  import.meta.dirname ?? ".",
  "../../dist/dashboard/index.html"
);
let cachedDashboardHtml: string | null = null;

function getDashboardHtml(): string {
  if (cachedDashboardHtml) return cachedDashboardHtml;
  if (existsSync(DASHBOARD_HTML_PATH)) {
    cachedDashboardHtml = readFileSync(DASHBOARD_HTML_PATH, "utf-8");
    return cachedDashboardHtml;
  }
  return "<html><body><h1>Dashboard not built</h1><p>Run: npm run build:dashboard</p></body></html>";
}

let server: Server | null = null;

/** Start the live monitoring dashboard. Call once at workflow start. */
export function startDashboard(workflow: string, port: number = 3838): void {
  if (server) return;

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/api/workflows") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(listWorkflows()));
      return;
    }

    if (url.pathname === "/api/dates") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(listDatesForWorkflow(wf)));
      return;
    }

    if (url.pathname === "/api/entries") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(readEntries(wf)));
      return;
    }

    if (url.pathname === "/api/logs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const runId = url.searchParams.get("runId") ?? "";
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      let logs = readLogEntries(wf, id || undefined);
      // Logs without runId belong to run #1 only
      if (runId) logs = logs.filter((l) => l.runId ? l.runId === runId : runId.endsWith("#1"));
      res.end(JSON.stringify(logs));
      return;
    }

    if (url.pathname === "/events/logs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const runId = url.searchParams.get("runId") ?? "";
      const date = url.searchParams.get("date") ?? "";
      const today = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      let sentCount = 0;
      let firstTick = true;
      const send = () => {
        let entries = (date && date !== today)
          ? readLogEntriesForDate(wf, id || undefined, date)
          : readLogEntries(wf, id || undefined);
        // Logs without runId belong to run #1 only
        if (runId) entries = entries.filter((l) => l.runId ? l.runId === runId : runId.endsWith("#1"));

        if (firstTick) {
          // First tick: send ALL existing logs so frontend has full history
          if (entries.length > 0) {
            res.write(`data: ${JSON.stringify(entries)}\n\n`);
          }
          sentCount = entries.length;
          firstTick = false;
        } else if (entries.length > sentCount) {
          // Subsequent ticks: send only new logs
          res.write(`data: ${JSON.stringify(entries.slice(sentCount))}\n\n`);
          sentCount = entries.length;
        }
      };
      send();
      const interval = setInterval(send, 500);
      req.on("close", () => clearInterval(interval));
      return;
    }

    if (url.pathname === "/events") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const date = url.searchParams.get("date") ?? "";
      const today = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      const send = () => {
        const raw = (date && date !== today)
          ? readEntriesForDate(wf, date)
          : readEntries(wf);
        const entries = raw;

        // Enrich entries with per-run log-derived timestamps for accurate elapsed
        const logs = (date && date !== today)
          ? readLogEntriesForDate(wf, undefined, date)
          : readLogEntries(wf);
        // Key: "itemId::runId" — logs without runId are assigned to run #1
        const logFirst = new Map<string, string>();
        const logLast = new Map<string, string>();
        const logLastMsg = new Map<string, string>();
        for (const l of logs) {
          const rid = l.runId || `${l.itemId}#1`;
          const key = `${l.itemId}::${rid}`;
          if (!logFirst.has(key)) logFirst.set(key, l.ts);
          logLast.set(key, l.ts);
          logLastMsg.set(key, l.message);
        }
        const enriched = entries.map((e) => {
          const key = `${e.id}::${e.runId || `${e.id}#1`}`;
          return { ...e, firstLogTs: logFirst.get(key), lastLogTs: logLast.get(key), lastLogMessage: logLastMsg.get(key) };
        });

        const workflows = listWorkflows();
        // Count deduped entries per workflow for dropdown badges
        const wfCounts: Record<string, number> = {};
        for (const w of workflows) {
          const all = readEntries(w);
          const ids = new Set(all.map((e) => e.id));
          wfCounts[w] = ids.size;
        }
        res.write(`data: ${JSON.stringify({ entries: enriched, workflows, wfCounts })}\n\n`);
      };
      send();
      const interval = setInterval(send, 1_000);
      req.on("close", () => clearInterval(interval));
      return;
    }

    if (url.pathname === "/api/runs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(readRunsForId(wf, id)));
      return;
    }

    if (url.pathname === "/api/preflight") {
      const deleted = cleanOldTrackerFiles(7);
      const checks = [
        { name: "Dashboard connected", passed: true, detail: "SSE server running" },
        { name: "Old logs cleaned", passed: true, detail: `${deleted} file${deleted !== 1 ? "s" : ""} removed (> 7 days)` },
      ];
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ checks }));
      return;
    }

    // No HTML served — use Vite dev server (port 5173) for the UI
    res.writeHead(404);
    res.end();
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.step(`Dashboard port ${port} in use — skipping (another instance may be running)`);
      server = null;
    }
  });

  server.listen(port, () => {
    log.step(`Live dashboard: http://localhost:${port}`);
  });
}

/** Stop the dashboard server. Call at workflow end. */
export function stopDashboard(): void {
  if (server) {
    server.close();
    server = null;
  }
}
