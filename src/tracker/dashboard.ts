import { createServer, type Server } from "http";
import { readFileSync, existsSync, unlinkSync, statSync, readdirSync, createReadStream } from "fs";
import { join, resolve, sep } from "path";
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
import {
  readSessionEvents,
  getSessionsFilePath,
  type SessionEvent,
} from "./session-events.js";
import { getAll as getAllRegisteredWorkflows } from "../core/registry.js";
import type { WorkflowMetadata } from "../core/types.js";

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

// ── Session state rebuilding from JSONL events ──────────

export interface BrowserState {
  browserId: string;
  system: string;
  authState: "idle" | "authenticating" | "authed" | "duo_waiting" | "failed";
}

export interface SessionInfo {
  sessionId: string;
  browsers: BrowserState[];
}

export interface WorkflowInstanceState {
  instance: string;
  active: boolean;
  /** True while the spawning Node process (and therefore its Playwright browsers) is still alive. */
  pidAlive: boolean;
  currentItemId: string | null;
  currentStep: string | null;
  finalStatus: "done" | "failed" | null;
  sessions: SessionInfo[];
}

export interface DuoQueueEntry {
  position: number;
  requestId: string;
  system: string;
  instance: string;
  state: "waiting" | "active";
}

export interface SessionState {
  workflows: WorkflowInstanceState[];
  duoQueue: DuoQueueEntry[];
}

export function rebuildSessionState(dir?: string): SessionState {
  const events = dir ? readSessionEvents(dir) : readSessionEvents();

  // Build workflow states
  const wfMap = new Map<string, WorkflowInstanceState>();
  for (const e of events) {
    const inst = e.workflowInstance;
    if (!inst) continue;

    if (e.type === "workflow_start") {
      wfMap.set(inst, {
        instance: inst,
        active: true,
        pidAlive: true,
        currentItemId: null,
        currentStep: null,
        finalStatus: null,
        sessions: [],
      });
    }
    if (e.type === "workflow_end") {
      const wf = wfMap.get(inst);
      if (wf) {
        wf.active = false;
        wf.finalStatus = e.finalStatus ?? null;
      }
    }
    if (e.type === "step_change" && e.currentStep) {
      const wf = wfMap.get(inst);
      if (wf) wf.currentStep = e.currentStep!;
    }
    if (e.type === "session_create" && e.sessionId) {
      const wf = wfMap.get(inst);
      if (wf && !wf.sessions.find((s) => s.sessionId === e.sessionId)) {
        wf.sessions.push({ sessionId: e.sessionId!, browsers: [] });
      }
    }
    if (e.type === "browser_launch" && e.sessionId && e.browserId && e.system) {
      const wf = wfMap.get(inst);
      const sess = wf?.sessions.find((s) => s.sessionId === e.sessionId);
      if (sess && !sess.browsers.find((b) => b.browserId === e.browserId)) {
        sess.browsers.push({ browserId: e.browserId!, system: e.system!, authState: "idle" });
      }
    }
    if (e.type === "browser_close" && e.browserId) {
      const wf = wfMap.get(inst);
      if (wf) {
        for (const sess of wf.sessions) {
          sess.browsers = sess.browsers.filter((b) => b.browserId !== e.browserId);
        }
      }
    }
    if (e.type === "auth_start" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b) b.authState = "authenticating";
    }
    if (e.type === "auth_complete" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b) b.authState = "authed";
    }
    if (e.type === "auth_failed" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b) b.authState = "failed";
    }
    if (e.type === "duo_request" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b) b.authState = "duo_waiting";
    }
    if (e.type === "duo_complete" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b && b.authState === "duo_waiting") b.authState = "authed";
    }
    if (e.type === "item_start" && e.currentItemId) {
      const wf = wfMap.get(inst);
      if (wf) wf.currentItemId = e.currentItemId!;
    }
    // Intentionally do NOT clear currentItemId on item_complete — the dashboard
    // keeps the last item visible after the workflow ends so users can see which
    // employee/record the session was for, even after it's done.
  }

  // Build Duo queue (unresolved requests only)
  const resolved = new Set<string>();
  for (const e of events) {
    if ((e.type === "duo_complete" || e.type === "duo_timeout") && e.duoRequestId) {
      resolved.add(e.duoRequestId);
    }
  }
  const duoQueue: DuoQueueEntry[] = [];
  let pos = 1;
  for (const e of events) {
    if (e.type === "duo_request" && e.duoRequestId && !resolved.has(e.duoRequestId)) {
      const started = events.some(
        (s) => s.type === "duo_start" && s.duoRequestId === e.duoRequestId,
      );
      duoQueue.push({
        position: pos++,
        requestId: e.duoRequestId,
        system: e.system || "",
        instance: e.workflowInstance,
        state: started ? "active" : "waiting",
      });
    }
  }

  // Overlay duo_waiting state: if a browser's system has a pending Duo request
  // for the same workflow instance, show it as duo_waiting instead of authenticating
  const workflows = [...wfMap.values()];
  for (const wf of workflows) {
    for (const sess of wf.sessions) {
      for (const b of sess.browsers) {
        const hasPendingDuo = duoQueue.some(
          (d) => d.instance === wf.instance && d.system === b.system,
        );
        if (hasPendingDuo && (b.authState === "authenticating" || b.authState === "idle")) {
          b.authState = "duo_waiting";
        }
      }
    }
  }

  // Check liveness of each workflow's spawning process. We split this from `active`:
  //   - `active`  = the workflow_start/end lifecycle (emitted by withTrackedWorkflow)
  //   - `pidAlive`= whether the Node process is still running (and therefore its browsers)
  // SessionPanel uses `pidAlive` to remove a workflow once its session is closed,
  // while `active` stays authoritative for the DONE/FAILED pill in the brief window
  // between workflow_end firing and the Node process exiting.
  for (const wf of workflows) {
    const startEv = events.find(
      (e) => e.type === "workflow_start" && e.workflowInstance === wf.instance,
    );
    if (!startEv) { wf.pidAlive = false; continue; }
    try { process.kill(startEv.pid, 0); wf.pidAlive = true; }
    catch { wf.pidAlive = false; }
  }

  return { workflows, duoQueue };
}

function findBrowser(
  wfMap: Map<string, WorkflowInstanceState>,
  instance: string,
  browserId: string,
): BrowserState | undefined {
  const wf = wfMap.get(instance);
  if (!wf) return undefined;
  for (const sess of wf.sessions) {
    const b = sess.browsers.find((b) => b.browserId === browserId);
    if (b) return b;
  }
  return undefined;
}

let server: Server | null = null;

/** Returns a handler that serves the registered workflow metadata as JSON. */
export function buildWorkflowsHandler(): () => WorkflowMetadata[] {
  return () => getAllRegisteredWorkflows();
}

/** Default root dir for kernel failure screenshots. Matches `screenshotAll`. */
export const SCREENSHOTS_DIR = ".screenshots";

export interface ScreenshotListEntry {
  filename: string;
  ts: string; // ISO-8601
  sizeBytes: number;
  step: string;
}

/**
 * Build a handler that lists PNGs in `.screenshots/` whose filename matches
 * `<workflow>-<itemId>-*`. Injectable root dir so tests can point at a
 * temp fixture dir. Returns `[]` when the dir doesn't exist or the prefix
 * matches nothing. Filenames produced by `Session.screenshotAll` have shape
 * `<workflow>-<itemId>-<step>-<systemId>-<timestamp>.png`; we parse `step` +
 * `ts` heuristically so the UI can show useful captions.
 */
export function buildScreenshotsHandler(
  rootDir: string = SCREENSHOTS_DIR,
): (workflow: string, itemId: string) => ScreenshotListEntry[] {
  return (workflow: string, itemId: string) => {
    if (!existsSync(rootDir)) return [];
    const prefix = `${workflow}-${itemId}-`;
    const out: ScreenshotListEntry[] = [];
    for (const f of readdirSync(rootDir)) {
      if (!f.endsWith(".png")) continue;
      if (!f.startsWith(prefix)) continue;
      const full = join(rootDir, f);
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(full).size;
      } catch {
        continue;
      }
      // Parse step + ts from the tail. Filename shape:
      //   <workflow>-<itemId>-<step>-<systemId>-<ts>.png
      // We can't split blindly because step names themselves can contain
      // dashes (e.g. "crm-auth"). Strategy: strip prefix, strip `.png`, split
      // by "-", take the trailing two segments as systemId + ts, the rest is
      // step. If the remainder is empty (malformed), leave step="".
      const stripped = f.slice(prefix.length, -".png".length);
      const segs = stripped.split("-");
      let step = "";
      let tsRaw = "";
      if (segs.length >= 3) {
        tsRaw = segs[segs.length - 1];
        // segs[segs.length - 2] is systemId — discarded in the UI caption
        step = segs.slice(0, segs.length - 2).join("-");
      } else if (segs.length === 2) {
        // Legacy: no step in the filename. Keep step empty.
        tsRaw = segs[1];
      }
      const tsNum = Number(tsRaw);
      const iso = Number.isFinite(tsNum) && tsNum > 0 ? new Date(tsNum).toISOString() : "";
      out.push({ filename: f, ts: iso, sizeBytes, step });
    }
    // Newest first — the UI scrolls horizontally, so latest on the left.
    out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return out;
  };
}

/**
 * Path-traversal-safe resolver. Accepts a screenshot filename (no path
 * separators) and returns the absolute path inside `rootDir`, or null if the
 * filename is malicious or the file doesn't exist inside the root.
 */
export function resolveScreenshotPath(
  filename: string,
  rootDir: string = SCREENSHOTS_DIR,
): string | null {
  // Cheap guard — no separators allowed, no "..".
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return null;
  }
  const rootAbs = resolve(rootDir);
  const fileAbs = resolve(rootDir, filename);
  // Defense in depth — ensure the resolved path is inside rootDir.
  const normalized = fileAbs + (fileAbs.endsWith(sep) ? "" : "");
  if (!normalized.startsWith(rootAbs + sep) && normalized !== rootAbs) {
    return null;
  }
  if (!existsSync(fileAbs)) return null;
  return fileAbs;
}

/**
 * Minimal TrackerEntry shape needed for step-duration computation. Kept
 * narrow (timestamp + status + step) so the function works against both
 * today's JSONL records and any shimmed test fixtures.
 */
interface StepDurationEntry {
  timestamp: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
}

/**
 * Compute per-step durations (ms) for a single (itemId, runId) pair.
 *
 * Input: entries for one run, in any order. Sorted internally by timestamp.
 * Output: `{ [stepName]: durationMs }`. Only steps with a computed duration
 * are included. The last step is closed out by a subsequent `done` / `failed`
 * event; a still-running final step yields no duration for that step (yet).
 *
 * Why pull this out of `/events`? It's pure data-over-data — easily unit
 * testable, easily reusable if we later want to expose durations through
 * another endpoint.
 */
export function computeStepDurations(
  entries: StepDurationEntry[],
): Record<string, number> {
  if (entries.length === 0) return {};

  // Defensive copy + sort by timestamp; input arrays are usually already in
  // order (JSONL is append-only) but test fixtures may not be.
  const sorted = [...entries].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );

  const durations: Record<string, number> = {};
  let currentStep: string | null = null;
  let currentStepStartMs: number | null = null;

  for (const e of sorted) {
    const tsMs = Date.parse(e.timestamp);
    if (Number.isNaN(tsMs)) continue;

    const isTerminal = e.status === "done" || e.status === "failed" || e.status === "skipped";
    const nextStep = isTerminal ? null : e.step ?? null;

    // When the active step changes (or we reach a terminal event), close out
    // the previous step's duration.
    if (currentStep && currentStep !== nextStep && currentStepStartMs !== null) {
      const delta = tsMs - currentStepStartMs;
      if (delta >= 0) {
        // Sum durations if a step re-appears (it won't normally, but be tolerant)
        durations[currentStep] = (durations[currentStep] ?? 0) + delta;
      }
    }

    if (nextStep !== currentStep) {
      currentStep = nextStep;
      currentStepStartMs = nextStep ? tsMs : null;
    }
  }

  return durations;
}

/** Start the live monitoring dashboard. Call once at workflow start. */
export interface StartDashboardOptions {
  /** Skip the one-time startup prune of old tracker files. */
  noClean?: boolean;
  /** Max age (days) for the startup prune. Defaults to 30 — conservative. */
  cleanMaxAgeDays?: number;
}

export function startDashboard(
  workflow: string,
  port: number = 3838,
  opts: StartDashboardOptions = {}
): void {
  if (server) return;

  // One-time startup prune — long retention by default (30 days) so the
  // dashboard boots with a clean working set without surprising the user.
  // Per-request /api/preflight still runs a 7-day prune for ongoing cleanup.
  if (!opts.noClean) {
    try {
      const maxAge = opts.cleanMaxAgeDays ?? 30;
      const deleted = cleanOldTrackerFiles(maxAge);
      if (deleted > 0) {
        log.step(`Pruned ${deleted} tracker file${deleted === 1 ? "" : "s"} older than ${maxAge} days`);
      }
    } catch (err) {
      // Don't fail startup if the tracker dir is missing or unreadable
      log.step(`Tracker startup prune skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/api/workflows") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(listWorkflows()));
      return;
    }

    if (url.pathname === "/api/workflow-definitions") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(buildWorkflowsHandler()()));
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

    if (url.pathname === "/events/sessions") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      const send = () => {
        const state = rebuildSessionState();
        res.write(`data: ${JSON.stringify(state)}\n\n`);
      };
      send();
      const interval = setInterval(send, 1_000);
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
        // `raw` holds every JSONL record for this workflow/date, including the
        // pending/running/done/failed chain per (itemId, runId). We need the
        // full chain for stepDurations; useEntries dedupes to the latest per id
        // on the frontend.
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

        // Compute step durations per (itemId, runId) from the full JSONL
        // history, not the deduped view. Each entry in `entries` inherits
        // the durations for its own run.
        const runHistory = new Map<string, StepDurationEntry[]>();
        for (const e of entries) {
          const rid = e.runId || `${e.id}#1`;
          const key = `${e.id}::${rid}`;
          const bucket = runHistory.get(key);
          const slim: StepDurationEntry = { timestamp: e.timestamp, status: e.status, step: e.step };
          if (bucket) bucket.push(slim);
          else runHistory.set(key, [slim]);
        }
        const stepDurationsByRun = new Map<string, Record<string, number>>();
        for (const [key, rows] of runHistory) {
          stepDurationsByRun.set(key, computeStepDurations(rows));
        }

        // Screenshot count for failed entries — counted once per (wf, itemId)
        // pair so repeat lookups in the loop don't hit the FS N times.
        const screenshotCountByItem = new Map<string, number>();
        const screenshotsHandler = buildScreenshotsHandler();

        const enriched = entries.map((e) => {
          const rid = e.runId || `${e.id}#1`;
          const key = `${e.id}::${rid}`;
          let screenshotCount: number | undefined;
          if (e.status === "failed") {
            const sKey = `${e.workflow}::${e.id}`;
            let c = screenshotCountByItem.get(sKey);
            if (c === undefined) {
              try {
                c = screenshotsHandler(e.workflow, e.id).length;
              } catch {
                c = 0;
              }
              screenshotCountByItem.set(sKey, c);
            }
            screenshotCount = c;
          }
          return {
            ...e,
            firstLogTs: logFirst.get(key),
            lastLogTs: logLast.get(key),
            lastLogMessage: logLastMsg.get(key),
            stepDurations: stepDurationsByRun.get(key) ?? {},
            ...(screenshotCount !== undefined ? { screenshotCount } : {}),
          };
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
      const date = url.searchParams.get("date") ?? undefined;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(readRunsForId(wf, id, date)));
      return;
    }

    if (url.pathname === "/api/screenshots") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("itemId") ?? url.searchParams.get("id") ?? "";
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      if (!wf || !id) {
        res.end(JSON.stringify([]));
        return;
      }
      try {
        const list = buildScreenshotsHandler()(wf, id);
        res.end(JSON.stringify(list));
      } catch {
        res.end(JSON.stringify([]));
      }
      return;
    }

    if (url.pathname.startsWith("/screenshots/")) {
      const filename = decodeURIComponent(url.pathname.slice("/screenshots/".length));
      const resolved = resolveScreenshotPath(filename);
      if (!resolved) {
        res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
        res.end("Not found");
        return;
      }
      try {
        const size = statSync(resolved).size;
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": size,
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
        });
        createReadStream(resolved).pipe(res);
      } catch {
        res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
        res.end("Error reading file");
      }
      return;
    }

    if (url.pathname === "/api/preflight") {
      const deleted = cleanOldTrackerFiles(7);

      // Only delete sessions.jsonl if it hasn't been touched for >24h (truly stale).
      // Stale workflows from crashed processes are handled by rebuildSessionState
      // which marks dead-PID workflows as inactive at read time — no file mutation needed.
      let sessionsCleaned = false;
      const sessPath = getSessionsFilePath();
      if (existsSync(sessPath)) {
        const ageMs = Date.now() - statSync(sessPath).mtimeMs;
        if (ageMs > 24 * 60 * 60 * 1000) {
          unlinkSync(sessPath);
          sessionsCleaned = true;
        }
      }

      const checks = [
        { name: "Dashboard connected", passed: true, detail: "SSE server running" },
        { name: "Old logs cleaned", passed: true, detail: `${deleted} file${deleted !== 1 ? "s" : ""} removed (> 7 days)` },
        { name: "Session state", passed: true, detail: sessionsCleaned ? "Stale session file cleaned" : "OK" },
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
