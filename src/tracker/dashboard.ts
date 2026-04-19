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
  cleanOldScreenshots,
  DEFAULT_DIR,
  type TrackerEntry,
} from "./jsonl.js";
import { log } from "../utils/log.js";
import {
  readSessionEvents,
  getSessionsFilePath,
  type SessionEvent,
} from "./session-events.js";
import { getAll as getAllRegisteredWorkflows } from "../core/registry.js";
import type { WorkflowMetadata } from "../core/types.js";
import { detectFailurePattern } from "./failure-detector.js";
import { notify } from "./notify.js";
import { pruneOldStepCache } from "../core/index.js";

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
    // Pick the LATEST workflow_start for this instance — when a workflow is re-run
    // under the same instance name, earlier starts reference dead pids. findLast
    // would be cleaner but target is ES2022; slice+reverse works without a lib bump.
    const starts = events.filter(
      (e: SessionEvent) => e.type === "workflow_start" && e.workflowInstance === wf.instance,
    );
    const startEv = starts[starts.length - 1];
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

/**
 * Cooldown map for failure-pattern alerts. Module-level so it survives the
 * lifetime of the dashboard process — keyed by `${workflow}:${error}`, value
 * is the last-alerted ms timestamp. Exposed via `__resetFailureAlertCooldown`
 * for test isolation.
 */
const failureAlertCooldown = new Map<string, number>();

/**
 * Test helper — clears the cooldown map so tests can re-run scans without
 * state bleed. Not part of the public API.
 */
export function __resetFailureAlertCooldown(): void {
  failureAlertCooldown.clear();
}

/**
 * Scan the current day's tracker entries across all known workflows for
 * repeated-failure patterns. Fires macOS notifications + log.warn for any
 * pattern that crosses the threshold and isn't in cooldown. Best-effort —
 * a notification failure never stalls the SSE poll cycle.
 *
 * Pulled out of the `/events` handler so it can be smoke-tested in isolation.
 */
export async function scanFailurePatterns(): Promise<void> {
  try {
    const workflows = listWorkflows();
    // Read today's entries for every workflow — concat and scan in one go.
    // The detector groups by (workflow, error) so cross-workflow mixing is fine.
    const all = workflows.flatMap((w) => readEntries(w));
    const patterns = detectFailurePattern(all, {
      cooldownState: failureAlertCooldown,
    });
    for (const p of patterns) {
      const windowMin = Math.round((Date.parse(p.lastTs) - Date.parse(p.firstTs)) / 60_000) || 1;
      const msg = `${p.workflow}: ${p.count}x ${p.error} in ${windowMin}m`;
      log.warn(`failure pattern detected — ${msg}`);
      // Don't block the poll cycle waiting for osascript — fire-and-forget.
      void notify("HR automation: failures", msg);
    }
  } catch (err) {
    // Best-effort — never crash the poll cycle.
    log.warn(`scanFailurePatterns skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
 * A single aggregated selector-fallback warning row. `label` is the text
 * captured from `safeClick`/`safeFill`'s `log.warn("selector fallback
 * triggered: <label>")` message. `count` is total occurrences across the
 * scanned window; `firstTs`/`lastTs` bracket that activity; `workflows`
 * is the distinct set of workflow names that emitted the warn.
 */
export interface SelectorWarningRow {
  label: string;
  count: number;
  firstTs: string;
  lastTs: string;
  workflows: string[];
}

/**
 * Regex that extracts the selector label from a `safeClick`/`safeFill`
 * instrumentation warn. Keep in sync with the format in
 * `src/systems/common/safe.ts`.
 */
const SELECTOR_FALLBACK_RE = /selector fallback triggered:\s*(.+)$/;

/**
 * Build a handler that scans log JSONL files in `dir` across the current day
 * plus `days - 1` prior days, keeps entries whose `level === "warn"` and
 * message matches `selector fallback triggered: <label>`, and returns one
 * aggregated `SelectorWarningRow` per distinct label (sorted by count desc,
 * tie-broken by most recent `lastTs`).
 *
 * Factored out of the HTTP handler so it can be unit-tested against a temp
 * directory without booting the SSE server.
 */
export function buildSelectorWarningsHandler(
  dir: string = ".tracker",
): (days: number) => SelectorWarningRow[] {
  return (days: number) => {
    if (!existsSync(dir)) return [];
    const daysNormalized = Math.max(1, Math.floor(days));
    const today = new Date();
    // Collect the list of YYYY-MM-DD dates to scan (today + prior days).
    const dates: string[] = [];
    for (let i = 0; i < daysNormalized; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    // Aggregate by label. Track distinct workflow set per label.
    const aggregated = new Map<
      string,
      { count: number; firstTs: string; lastTs: string; workflows: Set<string> }
    >();

    for (const f of readdirSync(dir)) {
      if (!f.endsWith("-logs.jsonl")) continue;
      // Match the date and workflow out of the filename: `<wf>-<YYYY-MM-DD>-logs.jsonl`
      const m = f.match(/^(.+)-(\d{4}-\d{2}-\d{2})-logs\.jsonl$/);
      if (!m) continue;
      const date = m[2];
      if (!dates.includes(date)) continue;

      let raw: string;
      try {
        raw = readFileSync(join(dir, f), "utf-8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let entry: { workflow?: string; level?: string; message?: string; ts?: string };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.level !== "warn" || typeof entry.message !== "string") continue;
        const match = entry.message.match(SELECTOR_FALLBACK_RE);
        if (!match) continue;
        const label = match[1].trim();
        if (!label) continue;
        const ts = typeof entry.ts === "string" ? entry.ts : "";
        const workflow = typeof entry.workflow === "string" ? entry.workflow : "";
        const prev = aggregated.get(label);
        if (prev) {
          prev.count += 1;
          if (ts && (!prev.firstTs || ts < prev.firstTs)) prev.firstTs = ts;
          if (ts && (!prev.lastTs || ts > prev.lastTs)) prev.lastTs = ts;
          if (workflow) prev.workflows.add(workflow);
        } else {
          aggregated.set(label, {
            count: 1,
            firstTs: ts,
            lastTs: ts,
            workflows: new Set(workflow ? [workflow] : []),
          });
        }
      }
    }

    // Emit rows, sorted by count desc then lastTs desc.
    return [...aggregated.entries()]
      .map(([label, agg]) => ({
        label,
        count: agg.count,
        firstTs: agg.firstTs,
        lastTs: agg.lastTs,
        workflows: [...agg.workflows].sort(),
      }))
      .sort((a, b) =>
        b.count - a.count || (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0),
      );
  };
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
 * One hit in the cross-date search. Keeps the shape thin so the frontend
 * dropdown can render quickly without needing another round-trip.
 */
export interface SearchResultRow {
  workflow: string;
  id: string;
  runId: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  /** Latest timestamp seen for this (workflow, id, runId). */
  lastTs: string;
  /** Date bucket (YYYY-MM-DD) the match lives in — used by the UI to deep-link. */
  date: string;
  /** Compact one-line summary (name / doc id / email). Never empty. */
  summary: string;
}

/**
 * Narrow reader-bundle shape the search handler depends on. Lets tests inject
 * in-memory fixtures instead of touching disk — matches the factory style used
 * by `buildScreenshotsHandler` / `buildSelectorWarningsHandler`.
 */
export interface SearchDeps {
  /** List workflows that have JSONL data (filters to known files). */
  listWorkflows: () => string[];
  /** List YYYY-MM-DD dates with entries for `wf`, newest first. */
  listDates: (wf: string) => string[];
  /** Read entries for a specific (wf, date) bucket. */
  readEntriesForDate: (wf: string, date: string) => TrackerEntry[];
}

/**
 * Fields on `data` the search matches against, in priority order. Priority
 * governs which value gets used for the result's summary string when multiple
 * match — emplId / docId outrank names because the operator can recognize a
 * record by its id even without a name.
 */
const SEARCH_FIELDS = [
  "emplId",
  "docId",
  "email",
  "firstName",
  "lastName",
  "name",
] as const;

/**
 * Build the `summary` cell for a search row. Prefers a human-readable name
 * (first + last or name), falls back to docId / email / emplId / id. Kept as a
 * pure helper so the unit test can exercise the precedence order without
 * going through the handler.
 */
export function buildSearchSummary(entry: TrackerEntry): string {
  const d = entry.data ?? {};
  const name = (d.__name || d.name || "").trim()
    || `${(d.firstName || "").trim()} ${(d.lastName || "").trim()}`.trim();
  if (name) return name;
  if (d.docId) return d.docId;
  if (d.email) return d.email;
  if (d.emplId) return d.emplId;
  return entry.id;
}

/**
 * Factory for the cross-date search handler. Scans `days` calendar days
 * (default 30) across either a single workflow or all workflows, filters
 * entries where {id, runId, or any of SEARCH_FIELDS on `data`} contain `q`
 * case-insensitively, and returns the top `limit` matches sorted by lastTs
 * desc.
 *
 * Entries are aggregated per (workflow, id, runId) — only the latest status
 * per run survives into the result list. This keeps the dropdown tight
 * without losing retry history (each retry has its own runId).
 *
 * Deps are injected so unit tests can feed in-memory JSONL fixtures without
 * hitting disk.
 */
export function buildSearchHandler(deps: SearchDeps) {
  return (
    q: string,
    opts: { workflow?: string; limit?: number; days?: number } = {},
  ): SearchResultRow[] => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 50;
    const days = opts.days && opts.days > 0 ? Math.floor(opts.days) : 30;

    // Target workflow list: single (if scoped) or every known workflow.
    const targetWorkflows = opts.workflow
      ? [opts.workflow]
      : deps.listWorkflows();

    // Cut-off date (YYYY-MM-DD). Strings compare lexicographically for
    // ISO dates, which is what we want here.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // Latest-per-run aggregation. Key: `${workflow}::${id}::${runId}`
    const byRun = new Map<string, { row: SearchResultRow; ts: string }>();

    const matches = (entry: TrackerEntry): boolean => {
      if (entry.id.toLowerCase().includes(query)) return true;
      if (entry.runId && entry.runId.toLowerCase().includes(query)) return true;
      const d = entry.data ?? {};
      for (const field of SEARCH_FIELDS) {
        const v = d[field];
        if (v && v.toLowerCase().includes(query)) return true;
      }
      // Also match the server-computed __name which carries first+last.
      if (d.__name && d.__name.toLowerCase().includes(query)) return true;
      return false;
    };

    for (const wf of targetWorkflows) {
      const dates = deps.listDates(wf);
      for (const date of dates) {
        if (date < cutoffStr) continue;
        const entries = deps.readEntriesForDate(wf, date);
        for (const e of entries) {
          if (!matches(e)) continue;
          const runId = e.runId || `${e.id}#1`;
          const key = `${wf}::${e.id}::${runId}`;
          const prev = byRun.get(key);
          // Keep the latest status for this run. Ties by timestamp break
          // toward the first-seen — append-only JSONL guarantees later
          // entries reflect the newest status.
          if (!prev || e.timestamp >= prev.ts) {
            byRun.set(key, {
              ts: e.timestamp,
              row: {
                workflow: wf,
                id: e.id,
                runId,
                status: e.status,
                lastTs: e.timestamp,
                date,
                summary: buildSearchSummary(e),
              },
            });
          }
        }
      }
    }

    return [...byRun.values()]
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
      .slice(0, limit)
      .map((x) => x.row);
  };
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

/**
 * Memoized per-step average durations (ms) keyed by `${workflow}::${dir}`.
 * TTL'd at 60s to keep the /events poll cycle cheap even with dozens of
 * entries carrying cacheHits. The dir component in the key is what lets
 * parallel test servers in different temp dirs not cross-pollinate.
 */
const stepAvgsMemo = new Map<string, { ts: number; data: Record<string, number> }>();
const STEP_AVGS_TTL_MS = 60_000;

/**
 * Compute per-step historical average durations for a workflow across the
 * last 7 days, capped at 100 prior runs. Powers the `cacheStepAvgs` field
 * in the `/events` SSE payload so the frontend can render "saved ~Ns" chips
 * next to cached steps.
 *
 * Memoized 60s per (workflow, dir). Disk hits are proportional to the
 * number of matching daily JSONL files, not entries.
 */
function computeCacheStepAvgs(workflow: string, dir: string): Record<string, number> {
  const memoKey = `${workflow}::${dir}`;
  const cached = stepAvgsMemo.get(memoKey);
  if (cached && Date.now() - cached.ts < STEP_AVGS_TTL_MS) return cached.data;

  const now = new Date();
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    dates.push(d.toISOString().slice(0, 10));
  }

  const sumByStep: Record<string, { total: number; count: number }> = {};
  let runsCounted = 0;
  outer: for (const date of dates) {
    let entries: TrackerEntry[];
    try { entries = readEntriesForDate(workflow, date, dir); } catch { continue; }
    const byRun = new Map<string, TrackerEntry[]>();
    for (const e of entries) {
      const rid = e.runId || `${e.id}#1`;
      const arr = byRun.get(rid) ?? [];
      arr.push(e);
      byRun.set(rid, arr);
    }
    for (const [, runEntries] of byRun) {
      if (runsCounted >= 100) break outer;
      const slim: StepDurationEntry[] = runEntries.map((e) => ({
        timestamp: e.timestamp, status: e.status, step: e.step,
      }));
      const durations = computeStepDurations(slim);
      for (const [step, ms] of Object.entries(durations)) {
        if (!sumByStep[step]) sumByStep[step] = { total: 0, count: 0 };
        sumByStep[step].total += ms;
        sumByStep[step].count += 1;
      }
      runsCounted += 1;
    }
  }

  const avgs: Record<string, number> = {};
  for (const [step, { total, count }] of Object.entries(sumByStep)) {
    avgs[step] = Math.round(total / count);
  }
  stepAvgsMemo.set(memoKey, { ts: Date.now(), data: avgs });
  return avgs;
}

/** Start the live monitoring dashboard. Call once at workflow start. */
export interface StartDashboardOptions {
  /** Skip the one-time startup prune of old tracker files. */
  noClean?: boolean;
  /** Max age (days) for the startup prune. Defaults to 30 — conservative. */
  cleanMaxAgeDays?: number;
  /** Override tracker dir — mainly for test isolation. Defaults to DEFAULT_DIR. */
  dir?: string;
}

/**
 * Options for the lower-level `createDashboardServer` factory. Returns a live
 * `http.Server` bound to the requested port (0 = random, useful in tests).
 * Does NOT use the module-level singleton.
 */
export interface CreateDashboardServerOptions {
  workflow?: string;
  port?: number;
  dir?: string;
  noClean?: boolean;
  cleanMaxAgeDays?: number;
}

export function startDashboard(
  workflow: string,
  port: number = 3838,
  opts: StartDashboardOptions = {}
): void {
  if (server) return;
  server = createDashboardServer({
    workflow,
    port,
    dir: opts.dir,
    noClean: opts.noClean,
    cleanMaxAgeDays: opts.cleanMaxAgeDays,
  });
}

/**
 * Factory for an isolated dashboard `http.Server` instance. Unlike
 * `startDashboard`, this bypasses the module-level singleton and returns the
 * live `Server` object so tests can spin up per-test servers on random ports
 * (port 0) with per-test tracker directories.
 *
 * Production callers should continue to use `startDashboard`, which
 * preserves the singleton-guard + :3838 default binding behavior.
 */
export function createDashboardServer(opts: CreateDashboardServerOptions = {}): Server {
  const workflow = opts.workflow ?? "onboarding";
  const port = opts.port ?? 3838;
  const dir = opts.dir ?? DEFAULT_DIR;

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
    try {
      const maxAge = opts.cleanMaxAgeDays ?? 30;
      const deletedShots = cleanOldScreenshots(maxAge);
      if (deletedShots > 0) {
        log.step(`Pruned ${deletedShots} screenshot${deletedShots === 1 ? "" : "s"} older than ${maxAge} days`);
      }
    } catch (err) {
      log.step(`Screenshot startup prune skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const maxAge = opts.cleanMaxAgeDays ?? 30;
      const deletedCache = pruneOldStepCache(maxAge * 24);
      if (deletedCache > 0) {
        log.step(`Pruned ${deletedCache} step-cache file${deletedCache === 1 ? "" : "s"} older than ${maxAge} days`);
      }
    } catch (err) {
      log.step(`Step-cache startup prune skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Standard JSON response helper. */
  const sendJson = (res: import("http").ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(JSON.stringify(body));
  };

  const localServer: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // CORS preflight — kept for any future POST endpoints.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (url.pathname === "/api/workflows") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(listWorkflows(dir)));
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
      res.end(JSON.stringify(listDatesForWorkflow(wf, dir)));
      return;
    }

    if (url.pathname === "/api/entries") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(readEntries(wf, dir)));
      return;
    }

    if (url.pathname === "/api/logs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const runId = url.searchParams.get("runId") ?? "";
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      let logs = readLogEntries(wf, id || undefined, dir);
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
          ? readLogEntriesForDate(wf, id || undefined, date, dir)
          : readLogEntries(wf, id || undefined, dir);
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

    if (url.pathname === "/events/run-events") {
      const requestedRunId = url.searchParams.get("runId") ?? "";
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      // TODO(2026-04-26): delete the fallback path once all events have runId.
      const RUNID_FALLBACK_UNTIL = new Date("2026-04-26T00:00:00Z").getTime();
      const fallbackEnabled = Date.now() < RUNID_FALLBACK_UNTIL;

      let sentCount = 0;
      let firstTick = true;

      const send = () => {
        // Read session events tolerantly — skip malformed lines instead of
        // letting a bad JSON line break the whole poll cycle. `readSessionEvents`
        // does a strict JSON.parse, so we inline a best-effort reader here.
        const sessionsPath = getSessionsFilePath(dir);
        const allEvents: SessionEvent[] = [];
        try {
          if (existsSync(sessionsPath)) {
            const raw = readFileSync(sessionsPath, "utf-8");
            for (const line of raw.split("\n")) {
              if (!line) continue;
              try {
                allEvents.push(JSON.parse(line) as SessionEvent);
              } catch {
                // Skip unparseable JSONL lines without derailing the stream.
              }
            }
          }
        } catch {
          // Any read failure → empty list; next tick may recover.
        }

        let filtered = allEvents.filter((e) => e.runId === requestedRunId);

        if (fallbackEnabled) {
          const anchor = allEvents.find(
            (e) => e.type === "workflow_start" && e.runId === requestedRunId,
          );
          if (anchor) {
            const pidMatched = allEvents.filter(
              (e) => !e.runId && e.pid === anchor.pid,
            );
            filtered = [...filtered, ...pidMatched];
          }
        }

        filtered.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        if (firstTick) {
          if (filtered.length > 0) res.write(`data: ${JSON.stringify(filtered)}\n\n`);
          sentCount = filtered.length;
          firstTick = false;
        } else if (filtered.length > sentCount) {
          res.write(`data: ${JSON.stringify(filtered.slice(sentCount))}\n\n`);
          sentCount = filtered.length;
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
        const state = rebuildSessionState(dir);
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
          ? readEntriesForDate(wf, date, dir)
          : readEntries(wf, dir);
        const entries = raw;

        // Enrich entries with per-run log-derived timestamps for accurate elapsed
        const logs = (date && date !== today)
          ? readLogEntriesForDate(wf, undefined, date, dir)
          : readLogEntries(wf, undefined, dir);
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

        // ── Cache-hit enrichment ────────────────────────────────────────
        // Read session events tolerantly and map cache_hit records to each
        // runId. Tolerant JSON parse matches the pattern used in
        // /events/run-events so a malformed line doesn't derail the cycle.
        const sessionEventsForEnrichment: SessionEvent[] = [];
        try {
          const sessPath = getSessionsFilePath(dir);
          if (existsSync(sessPath)) {
            const content = readFileSync(sessPath, "utf-8");
            for (const line of content.split("\n")) {
              if (!line.trim()) continue;
              try { sessionEventsForEnrichment.push(JSON.parse(line) as SessionEvent); } catch { /* skip malformed */ }
            }
          }
        } catch { /* ignore */ }

        const cacheHitsByRun = new Map<string, Set<string>>();
        for (const ev of sessionEventsForEnrichment) {
          if (ev.type !== "cache_hit" || !ev.runId || !ev.step) continue;
          const set = cacheHitsByRun.get(ev.runId) ?? new Set<string>();
          set.add(ev.step);
          cacheHitsByRun.set(ev.runId, set);
        }

        const stepAvgs = computeCacheStepAvgs(wf, dir);

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
          const hits = cacheHitsByRun.get(rid);
          let cacheHitsField: string[] | undefined;
          let cacheStepAvgsField: Record<string, number> | undefined;
          if (hits && hits.size > 0) {
            cacheHitsField = Array.from(hits);
            const avgs: Record<string, number> = {};
            for (const step of hits) {
              if (stepAvgs[step] != null && stepAvgs[step] > 0) avgs[step] = stepAvgs[step];
            }
            cacheStepAvgsField = avgs;
          }
          return {
            ...e,
            firstLogTs: logFirst.get(key),
            lastLogTs: logLast.get(key),
            lastLogMessage: logLastMsg.get(key),
            stepDurations: stepDurationsByRun.get(key) ?? {},
            ...(screenshotCount !== undefined ? { screenshotCount } : {}),
            ...(cacheHitsField !== undefined ? { cacheHits: cacheHitsField } : {}),
            ...(cacheStepAvgsField !== undefined ? { cacheStepAvgs: cacheStepAvgsField } : {}),
          };
        });

        const workflows = listWorkflows(dir);
        // Count unique items per workflow for dropdown badges, scoped to the
        // selected date. Dedupe by `id` so multiple runs of the same item
        // (retries) collapse into one — the operator wants "how many distinct
        // subjects on this date," not "how many attempts." Using readEntries(w)
        // — which only reads today's file — would show 0 when viewing a past
        // date, even if that date had real activity.
        const wfCounts: Record<string, number> = {};
        const targetDate = date || today;
        for (const w of workflows) {
          const all = readEntriesForDate(w, targetDate, dir);
          const ids = new Set(all.map((e) => e.id));
          wfCounts[w] = ids.size;
        }
        res.write(`data: ${JSON.stringify({ entries: enriched, workflows, wfCounts })}\n\n`);

        // After each poll, scan for repeated-failure patterns. Fire-and-forget
        // — the SSE response doesn't wait on it, and scanFailurePatterns
        // swallows its own errors so a notification glitch can't derail the
        // cycle.
        void scanFailurePatterns();
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

      // Attach per-run step durations + first/last log timestamps so the
      // frontend can render the correct timeline + Started/Elapsed for
      // whichever run the operator picks in RunSelector. Without this, the
      // deduped entry (latest run) bleeds its timings into every past run.
      const runs = readRunsForId(wf, id, date, dir);

      const allForItem = date
        ? readEntriesForDate(wf, date, dir).filter((e) => e.id === id)
        : readEntries(wf, dir).filter((e) => e.id === id);
      const historyByRun = new Map<string, StepDurationEntry[]>();
      for (const e of allForItem) {
        const rid = e.runId || `${e.id}#1`;
        const bucket = historyByRun.get(rid);
        const slim: StepDurationEntry = { timestamp: e.timestamp, status: e.status, step: e.step };
        if (bucket) bucket.push(slim);
        else historyByRun.set(rid, [slim]);
      }

      const allLogs = date
        ? readLogEntriesForDate(wf, id, date, dir)
        : readLogEntries(wf, id, dir);
      const logFirst = new Map<string, string>();
      const logLast = new Map<string, string>();
      for (const l of allLogs) {
        const rid = l.runId || `${l.itemId}#1`;
        if (!logFirst.has(rid)) logFirst.set(rid, l.ts);
        logLast.set(rid, l.ts);
      }

      const enrichedRuns = runs.map((r) => ({
        ...r,
        stepDurations: computeStepDurations(historyByRun.get(r.runId) ?? []),
        firstLogTs: logFirst.get(r.runId),
        lastLogTs: logLast.get(r.runId),
      }));
      res.end(JSON.stringify(enrichedRuns));
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
      return;
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
      // 30-day floor so the operator always has at least the last month
      // of workflow history available for retro investigation.
      const deleted = cleanOldTrackerFiles(30, dir);

      // Only delete sessions.jsonl if it hasn't been touched for >24h (truly stale).
      // Stale workflows from crashed processes are handled by rebuildSessionState
      // which marks dead-PID workflows as inactive at read time — no file mutation needed.
      let sessionsCleaned = false;
      const sessPath = getSessionsFilePath(dir);
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

  localServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.step(`Dashboard port ${port} in use — skipping (another instance may be running)`);
      // If this server was installed as the module-level singleton, clear it.
      if (server === localServer) server = null;
    }
  });

  localServer.listen(port, () => {
    const addr = localServer.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    // Skip the startup log when port=0 (test fixture). Otherwise announce.
    if (port !== 0) {
      log.step(`Live dashboard: http://localhost:${boundPort}`);
    }
  });

  return localServer;
}

/** Stop the dashboard server. Call at workflow end. */
export function stopDashboard(): void {
  if (server) {
    server.close();
    server = null;
  }
}
