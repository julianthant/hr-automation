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
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(readLogEntries(wf, id || undefined)));
      return;
    }

    if (url.pathname === "/events/logs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const date = url.searchParams.get("date") ?? "";
      const today = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      let lastCount = 0;
      const send = () => {
        const entries = (date && date !== today)
          ? readLogEntriesForDate(wf, id || undefined, date)
          : readLogEntries(wf, id || undefined);
        if (entries.length > lastCount) {
          res.write(`data: ${JSON.stringify(entries.slice(lastCount))}\n\n`);
          lastCount = entries.length;
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
        const entries = (date && date !== today)
          ? readEntriesForDate(wf, date)
          : readEntries(wf);
        const workflows = listWorkflows();
        res.write(`data: ${JSON.stringify({ entries, workflows })}\n\n`);
      };
      send();
      const interval = setInterval(send, 1_000);
      req.on("close", () => clearInterval(interval));
      return;
    }

    // Serve HTML dashboard
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getDashboardHtml());
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
