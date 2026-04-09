import { createServer, type Server } from "http";
import { readEntries } from "./jsonl.js";
import { log } from "../utils/log.js";

let server: Server | null = null;

export function startDashboard(workflow: string, port: number = 3838): void {
  if (server) return;
  server = createServer((req, res) => {
    if (req.url === "/api/entries") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(readEntries(workflow)));
      return;
    }
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const interval = setInterval(() => {
        const entries = readEntries(workflow);
        res.write(`data: ${JSON.stringify(entries)}\n\n`);
      }, 1_000);
      req.on("close", () => clearInterval(interval));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getDashboardHtml(workflow));
  });
  server.listen(port, () => {
    log.step(`Live dashboard: http://localhost:${port}`);
  });
}

export function stopDashboard(): void {
  if (server) { server.close(); server = null; }
}

function getDashboardHtml(workflow: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>HR Automation — ${workflow}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 16px; color: #f8fafc; }
  .stats { display: flex; gap: 16px; margin-bottom: 20px; }
  .stat { background: #1e293b; border-radius: 8px; padding: 16px 24px; min-width: 120px; }
  .stat-value { font-size: 2rem; font-weight: 700; }
  .stat-label { font-size: 0.75rem; text-transform: uppercase; color: #94a3b8; margin-top: 4px; }
  .done .stat-value { color: #4ade80; }
  .failed .stat-value { color: #f87171; }
  .running .stat-value { color: #60a5fa; }
  .total .stat-value { color: #f8fafc; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; }
  th { background: #334155; padding: 10px 14px; text-align: left; font-size: 0.75rem; text-transform: uppercase; color: #94a3b8; }
  td { padding: 10px 14px; border-top: 1px solid #334155; font-size: 0.875rem; }
  tr.done td:nth-child(2) { color: #4ade80; }
  tr.failed td:nth-child(2) { color: #f87171; }
  tr.running td:nth-child(2) { color: #60a5fa; }
  tr.pending td:nth-child(2) { color: #94a3b8; }
  .error { color: #fca5a5; font-size: 0.75rem; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .time { color: #94a3b8; font-size: 0.75rem; }
</style>
</head>
<body>
<h1>${workflow}</h1>
<div class="stats" id="stats"></div>
<table>
<thead><tr><th>ID</th><th>Status</th><th>Step</th><th>Time</th><th>Error</th></tr></thead>
<tbody id="tbody"></tbody>
</table>
<script>
const es = new EventSource("/events");
es.onmessage = (e) => {
  const entries = JSON.parse(e.data);
  const latest = new Map();
  entries.forEach(en => latest.set(en.id, en));
  const rows = [...latest.values()];
  const done = rows.filter(r => r.status === "done").length;
  const failed = rows.filter(r => r.status === "failed").length;
  const running = rows.filter(r => r.status === "running").length;
  const total = rows.length;
  document.getElementById("stats").innerHTML =
    '<div class="stat total"><div class="stat-value">' + total + '</div><div class="stat-label">Total</div></div>' +
    '<div class="stat done"><div class="stat-value">' + done + '</div><div class="stat-label">Done</div></div>' +
    '<div class="stat failed"><div class="stat-value">' + failed + '</div><div class="stat-label">Failed</div></div>' +
    '<div class="stat running"><div class="stat-value">' + running + '</div><div class="stat-label">Running</div></div>';
  document.getElementById("tbody").innerHTML = rows.map(r =>
    '<tr class="' + r.status + '"><td>' + r.id + '</td><td>' + r.status + '</td><td>' + (r.step || "-") + '</td><td class="time">' + (r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : "") + '</td><td class="error">' + (r.error || "") + '</td></tr>'
  ).join("");
};
</script>
</body>
</html>`;
}
