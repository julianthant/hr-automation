import { createServer, type Server } from "http";
import { readFileSync, existsSync, unlinkSync, statSync, readdirSync, createReadStream, watchFile, unwatchFile } from "fs";
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
import { errorMessage } from "../utils/errors.js";
import {
  readSessionEvents,
  getSessionsFilePath,
  workflowNameFromInstance,
  type SessionEvent,
} from "./session-events.js";
import { getAll as getAllRegisteredWorkflows } from "../core/registry.js";
import type { WorkflowMetadata } from "../core/types.js";
import { PATHS } from "../config.js";
import { stopDaemons } from "../core/daemon-client.js";
import { enqueueFromHttp, validateEnqueueRequest } from "../core/enqueue-dispatch.js";
import {
  buildRetryHandler,
  buildRetryBulkHandler,
  buildRunWithDataHandler,
  buildCancelQueuedHandler,
  buildQueueBumpHandler,
  buildDaemonsListHandler,
  buildDaemonsSpawnHandler,
  buildDaemonsStopHandler,
  resolveDaemonLogPath,
  readQueueDepth,
} from "./dashboard-ops.js";
import { detectFailurePattern } from "./failure-detector.js";
import { notify } from "./notify.js";
import {
  buildSharePointRosterDownloadHandler,
  buildSharePointListHandler,
} from "../workflows/sharepoint-download/index.js";

/**
 * Canonical sort key for a session event. Events emitted by
 * emitScreenshotEvent use numeric `ts` (ms since epoch) while other
 * event emitters use ISO `timestamp`. Normalize both into an ISO string
 * so localeCompare sorts correctly.
 */
export function getEventSortKey(e: { timestamp?: string; ts?: number }): string {
  if (typeof e.timestamp === "string" && e.timestamp.length > 0) return e.timestamp;
  if (typeof e.ts === "number" && Number.isFinite(e.ts)) return new Date(e.ts).toISOString();
  return "";
}

/**
 * Resolve a runId to its batch's workflowInstance by looking up the tracker
 * entry that carries that runId. Returns the first matching `data.instance`
 * string, or `undefined` if no entry is found or the entry lacks the field.
 *
 * Pre-2026-04-21 entries may not have `data.instance`; those degrade to
 * `undefined` and the caller's batch-scope fallback becomes a no-op.
 */
export function resolveInstanceForRun(
  trackers: Array<Pick<TrackerEntry, "runId" | "data">>,
  runId: string,
): string | undefined {
  if (!runId) return undefined;
  for (const t of trackers) {
    if (t.runId !== runId) continue;
    const instance = t.data?.instance;
    if (typeof instance === "string" && instance.length > 0) return instance;
  }
  return undefined;
}

/**
 * Filter session events down to those that belong to a single run. Used by
 * the `/events/run-events` SSE handler.
 *
 * Two matching paths:
 *
 * 1. **Direct:** events carrying the exact requested `runId`.
 * 2. **Batch-scope fallback:** events emitted outside any per-item
 *    `withLogContext` (so they have no `runId`), attributed to this run via
 *    matching `workflowInstance` AND falling within the run's
 *    `[runStart, runEnd]` time window. `Session.launch` emits `auth_start` /
 *    `auth_complete` / `browser_launch` at batch scope without a runId.
 *
 * **Time-window in daemon mode.** A batch workflow (sequential/pool/
 * shared-context-pool) assigns one `workflowInstance` per batch, so
 * `workflowInstance` alone isolates each batch. A **daemon** keeps the same
 * `workflowInstance` for its entire lifetime — it processes many items
 * (each a distinct `runId`) under one instance. Without the time window,
 * orphan events from every past or concurrent item in the daemon would
 * bleed into each item's drill-in view. Filtering orphan events to the
 * target run's tracker-entry span fixes the leak without breaking legacy
 * batch shapes (a batch's orphan events all fall inside the batch's span
 * anyway).
 *
 * `runStart` = earliest tracker-entry timestamp for this runId.
 * `runEnd` = max(latest tracker ts for runId, latest direct-event ts for
 * runId, `now` — via `runEndFallback` arg, default `Date.now()`). The
 * `now`/direct-event extension matters for in-progress items where no
 * terminal tracker entry exists yet.
 *
 * Pure: no filesystem access. Clock is injected via `runEndFallback` so
 * tests stay deterministic.
 */
export function filterEventsForRun(
  events: SessionEvent[],
  trackers: Array<Pick<TrackerEntry, "runId" | "status" | "data" | "timestamp">>,
  runId: string,
  runEndFallback: number = Date.now(),
): SessionEvent[] {
  const direct = events.filter((e) => e.runId === runId);
  const instance = resolveInstanceForRun(trackers, runId);

  let batchScope: SessionEvent[] = [];
  if (instance) {
    const runEntries = trackers.filter((t) => t.runId === runId);
    if (runEntries.length === 0) {
      // Degenerate: instance resolved but no tracker entries to build a
      // window from. Skip the fallback rather than over-include.
      batchScope = [];
    } else {
      const trackerTimes = runEntries
        .map((t) => new Date(t.timestamp).getTime())
        .filter((n) => Number.isFinite(n));
      const directTimes = direct
        .map((e) => new Date(getEventSortKey(e)).getTime())
        .filter((n) => Number.isFinite(n));
      const runStart = Math.min(...trackerTimes);
      // If this run reached a terminal status (done / failed / skipped),
      // cap runEnd at the last tracker timestamp. Without this check, the
      // default `runEndFallback = Date.now()` stretched the window all the
      // way to "now", pulling in orphan events from later items that the
      // same daemon processed on the same `workflowInstance`.
      const terminated = runEntries.some(
        (t) => t.status === "done" || t.status === "failed" || t.status === "skipped",
      );
      const lastTrackerTs = Math.max(...trackerTimes);
      const runEnd = terminated
        ? Math.max(lastTrackerTs, ...(directTimes.length > 0 ? directTimes : []))
        : Math.max(
            lastTrackerTs,
            ...(directTimes.length > 0 ? directTimes : []),
            runEndFallback,
          );
      batchScope = events.filter((e) => {
        if (e.runId) return false;
        if (e.workflowInstance !== instance) return false;
        const ets = new Date(getEventSortKey(e)).getTime();
        if (!Number.isFinite(ets)) return false;
        return ets >= runStart && ets <= runEnd;
      });
    }
  }

  const merged = [...direct, ...batchScope];
  merged.sort((a, b) => getEventSortKey(a).localeCompare(getEventSortKey(b)));
  return merged;
}

/**
 * How long after a crash-on-launch the dashboard keeps rendering the red
 * "Launch failed" placeholder in the live Sessions rail. Past this window the
 * failed run is considered historical — details still live in
 * `.tracker/sessions.jsonl` and the workflow's per-day log, but the Sessions
 * panel (which is a "live / currently happening" view) stops pinning it.
 */
const CRASH_ON_LAUNCH_WINDOW_MS = 15 * 60 * 1000;

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
  /** Kebab-case workflow name resolved from the instance label (e.g. "Separation 1" → "separations"). null when unrecognised. */
  workflow: string | null;
  active: boolean;
  /** True while the spawning Node process (and therefore its Playwright browsers) is still alive. */
  pidAlive: boolean;
  /**
   * True when workflow_end (finalStatus=failed) fired but no browser_launch event
   * was ever emitted for this instance — i.e. the workflow crashed before
   * Playwright launched a browser. Used by the dashboard to render a
   * "Launch failed" placeholder in place of the usual session/browser chips.
   */
  crashedOnLaunch?: boolean;
  currentItemId: string | null;
  /** True between item_start and item_complete — i.e. a real item is currently being processed. */
  itemInFlight: boolean;
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
        workflow: workflowNameFromInstance(inst),
        active: true,
        pidAlive: true,
        currentItemId: null,
        itemInFlight: false,
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
      if (wf) {
        wf.currentItemId = e.currentItemId!;
        wf.itemInFlight = true;
      }
    }
    if (e.type === "item_complete") {
      const wf = wfMap.get(inst);
      if (wf) wf.itemInFlight = false;
    }
    // Intentionally do NOT clear currentItemId on item_complete — the dashboard
    // keeps the last item visible after the workflow ends so users can see which
    // employee/record the session was for, even after it's done.
  }

  // Flag workflows that crashed before any browser could launch. A workflow that
  // ended in failed status but never emitted a browser_launch is indistinguishable
  // from normal "no-active-sessions" in the dashboard UI — this flag lets
  // SessionPanel render a dedicated "Launch failed" placeholder so the user
  // knows the run crashed early and where to look for details.
  //
  // Age gate: SessionPanel keeps crashedOnLaunch entries visible even after
  // pidAlive flips false (that's the point of the placeholder — the Node
  // process that crashed is already gone). But sessions.jsonl is append-only
  // across orchestrator sessions, so without a time cutoff a crash from days
  // ago would permanently pin itself to the live Sessions rail. Only flag
  // crashes whose workflow_end is within CRASH_ON_LAUNCH_WINDOW_MS.
  const instancesWithBrowserLaunch = new Set<string>();
  const workflowEndTimestamps = new Map<string, string>();
  for (const e of events) {
    if (e.type === "browser_launch" && e.workflowInstance) {
      instancesWithBrowserLaunch.add(e.workflowInstance);
    }
    if (e.type === "workflow_end" && e.workflowInstance && e.timestamp) {
      workflowEndTimestamps.set(e.workflowInstance, e.timestamp);
    }
  }
  const now = Date.now();
  for (const wf of wfMap.values()) {
    if (wf.finalStatus !== "failed") continue;
    if (instancesWithBrowserLaunch.has(wf.instance)) continue;
    const endTs = workflowEndTimestamps.get(wf.instance);
    if (!endTs) continue;
    const ageMs = now - Date.parse(endTs);
    if (Number.isFinite(ageMs) && ageMs <= CRASH_ON_LAUNCH_WINDOW_MS) {
      wf.crashedOnLaunch = true;
    }
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
  //
  // In-process (fire-and-forget) workflows: when a workflow runs INSIDE the
  // dashboard server process (e.g. the `sharepoint-download` HTTP handler
  // fires `runWorkflow()` without awaiting), the recorded pid equals the
  // dashboard's own pid — so `process.kill(pid, 0)` always succeeds while
  // the dashboard is up, pinning the workflow box to the Sessions rail
  // forever even after it has completed or failed. Treat an in-process run
  // as "session ended" the moment `workflow_end` fires, matching the behavior
  // of spawned-child workflows whose process exits shortly after end. This
  // keeps the Sessions rail consistent across both execution models.
  const ownPid = process.pid;
  for (const wf of workflows) {
    // Pick the LATEST workflow_start for this instance — when a workflow is re-run
    // under the same instance name, earlier starts reference dead pids. findLast
    // would be cleaner but target is ES2022; slice+reverse works without a lib bump.
    const starts = events.filter(
      (e: SessionEvent) => e.type === "workflow_start" && e.workflowInstance === wf.instance,
    );
    const startEv = starts[starts.length - 1];
    if (!startEv) { wf.pidAlive = false; continue; }
    if (startEv.pid === ownPid && wf.finalStatus !== null) {
      wf.pidAlive = false;
      continue;
    }
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
export const SCREENSHOTS_DIR = PATHS.screenshotDir;

export interface ScreenshotListEntry {
  filename: string;
  ts: string; // ISO-8601
  sizeBytes: number;
  step: string;
}

/**
 * Grouped screenshot entry — one per screenshot tracker event (or one
 * synthetic entry for all "legacy" files that have no matching event).
 * Returned by the `{ dir, screenshotsDir }` overload of
 * `buildScreenshotsHandler`.
 */
export interface ScreenshotGroupedEntry {
  ts: number;
  kind: "form" | "error" | "manual";
  label: string;
  step: string | null;
  files: Array<{ system: string; path: string; url: string }>;
}

/**
 * Build a handler that lists PNGs in `.screenshots/` whose filename matches
 * `<workflow>-<itemId>-*`. Injectable root dir so tests can point at a
 * temp fixture dir. Returns `[]` when the dir doesn't exist or the prefix
 * matches nothing. Filenames produced by `Session.screenshotAll` have shape
 * `<workflow>-<itemId>-<step>-<systemId>-<timestamp>.png`; we parse `step` +
 * `ts` heuristically so the UI can show useful captions.
 *
 * Overloaded: when called with `{ dir, screenshotsDir }` it returns an async
 * handler that reads `sessions.jsonl` and groups files by screenshot events,
 * surfacing unmatched / legacy files under a synthetic `kind=error label=legacy`
 * entry. When called with a string (or no args) it returns the legacy sync
 * flat-list handler — this overload is retained for backward compat with the
 * SSE enrichment loop.
 */
export function buildScreenshotsHandler(
  rootDir?: string,
): (workflow: string, itemId: string) => ScreenshotListEntry[];
export function buildScreenshotsHandler(deps: {
  dir: string;
  screenshotsDir: string;
}): (query: { workflow: string; itemId: string }) => Promise<ScreenshotGroupedEntry[]>;
export function buildScreenshotsHandler(
  arg: string | { dir: string; screenshotsDir: string } | undefined = SCREENSHOTS_DIR,
): unknown {
  // ── New grouped overload ────────────────────────────────────────────────────
  if (arg !== null && typeof arg === "object") {
    const { dir, screenshotsDir } = arg;
    return async function groupedHandler(
      query: { workflow: string; itemId: string },
    ): Promise<ScreenshotGroupedEntry[]> {
      const { workflow, itemId } = query;
      const prefix = `${workflow}-${itemId}-`;

      // 1. Read sessions.jsonl and collect screenshot events whose files
      //    touch the requested workflow/itemId.
      const sessPath = getSessionsFilePath(dir);
      const events: import("./session-events.js").ScreenshotSessionEvent[] = [];
      if (existsSync(sessPath)) {
        const raw = readFileSync(sessPath, "utf-8");
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            "type" in parsed &&
            (parsed as Record<string, unknown>)["type"] === "screenshot" &&
            "files" in parsed
          ) {
            const ev = parsed as import("./session-events.js").ScreenshotSessionEvent;
            // Include this event if ANY of its files belong to this workflow+itemId.
            const matches = ev.files.some((f) => {
              const base = f.path.split(/[/\\]/).pop() ?? "";
              return base.startsWith(prefix);
            });
            if (matches) events.push(ev);
          }
        }
      }

      // 2. Build grouped entries from events. Track which file paths are covered.
      //    Only include files that still exist on disk — sessions.jsonl persists
      //    across cleanup cycles so stale references are common.
      const coveredPaths = new Set<string>();
      const grouped: ScreenshotGroupedEntry[] = [];
      for (const ev of events) {
        const files: ScreenshotGroupedEntry["files"] = [];
        for (const f of ev.files) {
          if (!existsSync(f.path)) continue;
          coveredPaths.add(f.path);
          files.push({
            system: f.system,
            path: f.path,
            url: `/screenshots/${encodeURIComponent(f.path.split(/[/\\]/).pop() ?? "")}`,
          });
        }
        // Skip the entire entry if none of its files survived cleanup.
        if (files.length === 0) continue;
        grouped.push({
          ts: ev.ts,
          kind: ev.kind,
          label: ev.label,
          step: ev.step,
          files,
        });
      }

      // 3. Enumerate files in screenshotsDir; any not already covered become
      //    synthetic legacy entries (grouped all under one label="legacy").
      const legacyFiles: ScreenshotGroupedEntry["files"] = [];
      let legacyTs = 0;
      if (existsSync(screenshotsDir)) {
        for (const f of readdirSync(screenshotsDir)) {
          if (!f.endsWith(".png")) continue;
          if (!f.startsWith(prefix)) continue;
          const fullPath = join(screenshotsDir, f);
          if (coveredPaths.has(fullPath)) continue;

          // Parse TS from trailing numeric segment before .png
          const tsMatch = f.match(/-(\d+)\.png$/);
          const fileTsNum = tsMatch ? Number(tsMatch[1]) : 0;

          // Determine system: second-to-last dash-segment before the ts
          const stripped = f.slice(prefix.length, -".png".length);
          const segs = stripped.split("-");
          let system = "unknown";
          if (segs.length >= 2) {
            system = segs[segs.length - 2];
          }

          if (fileTsNum > legacyTs) legacyTs = fileTsNum;
          legacyFiles.push({
            system,
            path: fullPath,
            url: `/screenshots/${encodeURIComponent(f)}`,
          });
        }
      }
      if (legacyFiles.length > 0) {
        grouped.push({
          ts: legacyTs,
          kind: "error",
          label: "legacy",
          step: null,
          files: legacyFiles,
        });
      }

      // 4. Sort newest-first.
      grouped.sort((a, b) => b.ts - a.ts);
      return grouped;
    };
  }

  // ── Legacy flat-list overload (backward compat) ─────────────────────────────
  const rootDir: string = typeof arg === "string" ? arg : SCREENSHOTS_DIR;
  return (workflow: string, itemId: string): ScreenshotListEntry[] => {
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
 * instrumentation log line. Keep in sync with the format in
 * `src/systems/common/safe.ts`.
 *
 * Matches all three shapes that share the `selector fallback triggered:`
 * anchor:
 *   - legacy (pre-timing) : `selector fallback triggered: <label>`
 *   - slow-success (warn) : `selector fallback triggered: <label> (click took Nms — ...)`
 *   - failure (error)     : `selector fallback triggered: <label> (click failed after Nms — ...)`
 *
 * The lazy `[^(]+?` capture stops at the first `(` of the timing suffix (if
 * present) so every variant aggregates under the same `<label>` key.
 */
const SELECTOR_FALLBACK_RE = /selector fallback triggered:\s*([^(]+?)\s*(?:\(.*)?$/;

/**
 * Build a handler that scans log JSONL files in `dir` across the current day
 * plus `days - 1` prior days, keeps entries whose `level` is `warn` (slow
 * success) or `error` (failure) and whose message matches
 * `selector fallback triggered: <label>` (optionally followed by a timing
 * suffix), and returns one aggregated `SelectorWarningRow` per distinct
 * label (sorted by count desc, tie-broken by most recent `lastTs`).
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
        // Accept both warn (slow-success) and error (failure) — they share
        // the `selector fallback triggered:` marker. See safe.ts for shapes.
        if (
          (entry.level !== "warn" && entry.level !== "error") ||
          typeof entry.message !== "string"
        )
          continue;
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

// ── SharePoint roster download trigger ─────────────────────────────────────
//
// Factory + in-flight lock live in `src/workflows/sharepoint-download/` now;
// the dashboard just wires the factory into the HTTP route below. Routes are
// namespaced under /api/sharepoint-download/ to reflect that the button is
// workflow-agnostic (see `src/workflows/sharepoint-download/CLAUDE.md`).
export { isDownloadInFlight as isRosterDownloadInFlight } from "../workflows/sharepoint-download/index.js";
export type {
  RosterDownloadResponse,
  RosterDownloadHandlerOptions,
} from "../workflows/sharepoint-download/index.js";

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
 * The first step's start is anchored at the earliest valid timestamp in the
 * run (typically the `pending` event), NOT at its own `running` event. This
 * way the pre-first-step gap — browser launch, session setup, any time
 * between workflow start and the first emitted step — is absorbed into
 * step 1's duration instead of being silently lost. The upshot:
 * `sum(stepDurations)` tiles the full elapsed time shown by the global
 * `useElapsed` counter (pending → done/failed), so the timeline matches the
 * dashboard's top-level timer.
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
  // Anchor step 1 at the first non-`pending` event. The `pending` row is
  // written at enqueue time in daemon / pre-emit batch mode (potentially
  // minutes/hours before the item starts actual work), so using it would
  // bleed the full queue-wait duration into step 1's duration. The first
  // `running` event is the "work started here" moment; that's what the
  // step pipeline should measure.
  let workflowStartMs: number | null = null;
  let firstStepSeen = false;

  for (const e of sorted) {
    const tsMs = Date.parse(e.timestamp);
    if (Number.isNaN(tsMs)) continue;

    if (workflowStartMs === null && e.status !== "pending") workflowStartMs = tsMs;

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
      if (nextStep && !firstStepSeen) {
        // Anchor step 1 at the workflow's earliest timestamp so the
        // pre-first-step gap is absorbed. workflowStartMs is guaranteed
        // non-null here because we set it above on the first valid ts.
        currentStepStartMs = workflowStartMs ?? tsMs;
        firstStepSeen = true;
      } else {
        currentStepStartMs = nextStep ? tsMs : null;
      }
    }
  }

  return durations;
}

/**
 * Summary of a run's timeline derived from its tracker JSONL history.
 * `earliestTrackerTs` is the single source of truth for "when did this run
 * start" — it matches the anchor `computeStepDurations` uses, so the header
 * Elapsed timer, the step pipeline durations, and the queue-row elapsed all
 * reference the same t=0. For batch items that means the synthetic auth
 * `running` entries at `onAuthStart` timestamps (injected by `runOneItem` —
 * see src/core/workflow.ts) are what anchor the run.
 */
export interface RunTimeline {
  /** 1-indexed chronological position among runs for the same itemId. */
  ordinal: number;
  /** Earliest tracker-entry ts for this run. */
  earliestTrackerTs: string;
  /** Latest tracker-entry ts for this run. */
  latestTrackerTs: string;
}

/** Return the earlier of two ISO timestamps, ignoring undefined inputs. */
function pickEarlier(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/** Return the later of two ISO timestamps, ignoring undefined inputs. */
function pickLater(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Build a `runId → RunTimeline` map for all runs of a single itemId.
 *
 * Runs are ordered (and ordinals assigned) by each run's earliest tracker
 * entry timestamp, NOT by parsing the trailing `#N` off the runId. This
 * means the two coexisting runId shapes — legacy `{id}#N` and the UUID
 * format emitted by batch/pool runners — are numbered consistently:
 * "run #1" is always the chronologically first run for that item.
 *
 * Exported so both the SSE `/events` enrichment and `/api/runs` can use the
 * same assignment rule — the ordinal a queue row shows MUST match the
 * ordinal the RunSelector dropdown shows for the same runId.
 */
export function buildRunTimelines(
  entries: Array<{ runId?: string; id: string; timestamp: string; status?: string }>,
): Map<string, RunTimeline> {
  // `earliestTs` anchors the run's timer (header Elapsed, queue-row elapsed,
  // step pipeline widths). We prefer the first non-`pending` event — in
  // daemon mode and pre-emitted batch mode, the `pending` row is written
  // at enqueue time (potentially minutes/hours before the item claims a
  // worker), so using it would attribute the full queue-wait duration to
  // the item's elapsed timer. The first `running` / `done` / `failed` /
  // `skipped` event is the real "work started here" anchor. Items that
  // are still queued (only a `pending` row exists) fall back to the
  // pending timestamp so the queue row still has a sortable timestamp.
  const spans = new Map<
    string,
    { earliestWorkTs: string | null; earliestAnyTs: string; latestTs: string }
  >();
  for (const e of entries) {
    const rid = e.runId || `${e.id}#1`;
    const isWork = e.status !== "pending";
    const prev = spans.get(rid);
    if (!prev) {
      spans.set(rid, {
        earliestWorkTs: isWork ? e.timestamp : null,
        earliestAnyTs: e.timestamp,
        latestTs: e.timestamp,
      });
    } else {
      if (isWork && (prev.earliestWorkTs === null || e.timestamp < prev.earliestWorkTs)) {
        prev.earliestWorkTs = e.timestamp;
      }
      if (e.timestamp < prev.earliestAnyTs) prev.earliestAnyTs = e.timestamp;
      if (e.timestamp > prev.latestTs) prev.latestTs = e.timestamp;
    }
  }
  // Flatten: earliestTs = earliestWorkTs ?? earliestAnyTs (pending-only
  // queued runs fall back to the pending timestamp for sort stability).
  const spansFlat = new Map<string, { earliestTs: string; latestTs: string }>();
  for (const [rid, s] of spans) {
    spansFlat.set(rid, {
      earliestTs: s.earliestWorkTs ?? s.earliestAnyTs,
      latestTs: s.latestTs,
    });
  }
  // Secondary sort by runId keeps the assignment deterministic if two runs
  // share the same earliest timestamp (realistic for synthetic fixtures;
  // production tracker writes are microsecond-distinct).
  const sorted = [...spansFlat.entries()].sort(([ra, sa], [rb, sb]) =>
    sa.earliestTs < sb.earliestTs ? -1 :
    sa.earliestTs > sb.earliestTs ? 1 :
    ra.localeCompare(rb),
  );
  const out = new Map<string, RunTimeline>();
  sorted.forEach(([rid, span], i) => {
    out.set(rid, {
      ordinal: i + 1,
      earliestTrackerTs: span.earliestTs,
      latestTrackerTs: span.latestTs,
    });
  });
  return out;
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
          // First tick: ALWAYS send — even an empty array. The frontend's
          // useLogs hook transitions from "loading skeleton" to "loaded"
          // on its first message; skipping the write for an empty dataset
          // leaves the UI stuck on skeleton forever (e.g. for a runId that
          // has a pending/failed tracker row but never produced any logs).
          res.write(`data: ${JSON.stringify(entries)}\n\n`);
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
      const wf = url.searchParams.get("workflow") ?? workflow;
      const requestedRunId = url.searchParams.get("runId") ?? "";
      const date = url.searchParams.get("date") ?? "";
      const today = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      // Batch / pool / daemon workflows call `Session.launch` at batch scope
      // (outside per-item `withLogContext`), so their `auth_*` and
      // `browser_launch` session events carry a `workflowInstance` but no
      // `runId`. `filterEventsForRun` resolves `runId -> tracker entry ->
      // data.instance` and pulls in those batch-scope events by matching
      // instance. See `filterEventsForRun` jsdoc for the full contract.

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

        let trackerEntries: TrackerEntry[] = [];
        try {
          trackerEntries = (date && date !== today)
            ? readEntriesForDate(wf, date, dir)
            : readEntries(wf, dir);
        } catch {
          // Tracker read failure → instance fallback becomes a no-op for this tick.
        }

        const filtered = filterEventsForRun(allEvents, trackerEntries, requestedRunId);

        if (firstTick) {
          // First tick: ALWAYS send — matching /events/logs. Empty-array
          // sends are how useRunEvents learns "full history has been
          // delivered (and there's none)", dismissing its skeleton.
          res.write(`data: ${JSON.stringify(filtered)}\n\n`);
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

        // Per-item run timelines: ordinal + tracker-span. Enrichment below
        // folds `earliestTrackerTs` into firstLogTs and `latestTrackerTs`
        // into lastLogTs so the header Elapsed timer and queue-row elapsed
        // both anchor at the run's REAL start (which for batch items is
        // the synthetic auth running entry, pre-handler). This makes the
        // step pipeline tile elapsed exactly — sum(stepDurations) ≡
        // (lastLogTs - firstLogTs). See RunTimeline JSDoc for why.
        const entriesByItem = new Map<string, TrackerEntry[]>();
        for (const e of entries) {
          const arr = entriesByItem.get(e.id) ?? [];
          arr.push(e);
          entriesByItem.set(e.id, arr);
        }
        const timelinesByItem = new Map<string, Map<string, RunTimeline>>();
        for (const [itemId, rows] of entriesByItem) {
          timelinesByItem.set(itemId, buildRunTimelines(rows));
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
          // Fold the tracker-span into firstLogTs/lastLogTs so the frontend
          // reads a single "run start → now" window that includes the
          // synthetic auth entries (batch mode) or the pending entry (single
          // mode). Min/max across both sources keeps legacy log-only runs
          // behaving the same.
          const timeline = timelinesByItem.get(e.id)?.get(rid);
          const logFirstTs = logFirst.get(key);
          const logLastTs = logLast.get(key);
          const trackerFirstTs = timeline?.earliestTrackerTs;
          const trackerLastTs = timeline?.latestTrackerTs;
          const spanFirstTs = pickEarlier(logFirstTs, trackerFirstTs);
          const spanLastTs = pickLater(logLastTs, trackerLastTs);

          return {
            ...e,
            firstLogTs: spanFirstTs,
            lastLogTs: spanLastTs,
            lastLogMessage: logLastMsg.get(key),
            stepDurations: stepDurationsByRun.get(key) ?? {},
            ...(timeline ? { runOrdinal: timeline.ordinal } : {}),
            ...(screenshotCount !== undefined ? { screenshotCount } : {}),
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

      // Attach per-run step durations, a single timeline span (covers both
      // the synthetic auth tracker entries and the handler's log lines), and
      // a chronological ordinal so the UI labels runs consistently even for
      // UUID-format runIds. Both shapes ({id}#N, UUID) share the SAME
      // ordinal-assignment rule — see `buildRunTimelines`.
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

      const timelines = buildRunTimelines(allForItem);

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

      const enrichedRuns = runs.map((r) => {
        const timeline = timelines.get(r.runId);
        return {
          ...r,
          stepDurations: computeStepDurations(historyByRun.get(r.runId) ?? []),
          firstLogTs: pickEarlier(logFirst.get(r.runId), timeline?.earliestTrackerTs),
          lastLogTs: pickLater(logLast.get(r.runId), timeline?.latestTrackerTs),
          ...(timeline ? { runOrdinal: timeline.ordinal } : {}),
        };
      });
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
        const groupedHandler = buildScreenshotsHandler({ dir, screenshotsDir: SCREENSHOTS_DIR });
        const list = await groupedHandler({ workflow: wf, itemId: id });
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

    if (
      req.method === "GET" &&
      url.pathname === "/api/sharepoint-download/list"
    ) {
      const list = buildSharePointListHandler()();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(list));
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/sharepoint-download/run"
    ) {
      const handler = buildSharePointRosterDownloadHandler();
      try {
        // Inline body parse — the only POST route on this server that takes
        // a JSON body. A full body-parser middleware would be overkill.
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
          if (Buffer.concat(chunks).byteLength > 4096) {
            throw new Error("Request body too large");
          }
        }
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        let input: { id?: string } = {};
        if (raw) {
          try {
            input = JSON.parse(raw) as { id?: string };
          } catch {
            res.writeHead(400, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
            return;
          }
        }
        const { status, body } = await handler(input);
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(body));
      } catch (e) {
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: false, error: errorMessage(e) }));
      }
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/enqueue"
    ) {
      // Generic enqueue-to-daemon-queue endpoint for the dashboard Run
      // panel. Body: { workflow: string, inputs: object[] } — each input
      // is a typed workflow-input (e.g. {docId} for separations). Spawns
      // one daemon if none are alive (Duo prompt in operator's browser);
      // otherwise just appends to the shared queue and wakes alive
      // daemons. Returns 202 with {ok, workflow, enqueued}.
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
          // 64 KB cap — an enqueue body is just the workflow name + a
          // list of small input objects; anything larger is almost
          // certainly a bug or abuse.
          if (Buffer.concat(chunks).byteLength > 65_536) {
            throw new Error("Request body too large");
          }
        }
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        let input: { workflow?: string; inputs?: unknown[] } = {};
        if (raw) {
          try {
            input = JSON.parse(raw) as { workflow?: string; inputs?: unknown[] };
          } catch {
            res.writeHead(400, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
            return;
          }
        }
        const workflow = input.workflow?.trim();
        if (!workflow) {
          res.writeHead(400, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: false, error: "workflow is required" }));
          return;
        }
        if (!Array.isArray(input.inputs) || input.inputs.length === 0) {
          res.writeHead(400, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: false, error: "inputs must be a non-empty array" }));
          return;
        }
        // Pre-validate synchronously so schema / unknown-workflow errors
        // surface as 400s. After that, fire-and-forget the actual
        // enqueue+spawn — first-invocation spawn can wait up to 5min for
        // Duo auth, and we don't want the HTTP connection open that long
        // (matches the sharepoint-download/run fire-and-forget pattern).
        const validation = await validateEnqueueRequest(workflow, input.inputs);
        if (!validation.ok) {
          res.writeHead(400, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: false, workflow, enqueued: 0, error: validation.error }));
          return;
        }
        const enqueueInputs = input.inputs;
        void enqueueFromHttp(workflow, enqueueInputs, dir).catch((err) => {
          // Background task — log only. Pending tracker rows will already
          // be on disk by this point (onPreEmitPending fires after the
          // fast enqueueItems step); only the subsequent spawn/wake can
          // realistically fail here.
          // eslint-disable-next-line no-console
          console.error(`[POST /api/enqueue] background task failed: ${errorMessage(err)}`);
        });
        res.writeHead(202, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({
          ok: true,
          workflow,
          enqueued: enqueueInputs.length,
        }));
      } catch (e) {
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: false, error: errorMessage(e) }));
      }
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/daemon/stop"
    ) {
      // Thin proxy over stopDaemons() — discovers alive daemons for the
      // given workflow and POSTs /stop to each. Soft by default (drain
      // in-flight + exit); `force: true` for hard-stop.
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
          if (Buffer.concat(chunks).byteLength > 4096) {
            throw new Error("Request body too large");
          }
        }
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        let input: { workflow?: string; force?: boolean } = {};
        if (raw) {
          try {
            input = JSON.parse(raw) as { workflow?: string; force?: boolean };
          } catch {
            res.writeHead(400, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
            return;
          }
        }
        const workflow = input.workflow?.trim();
        if (!workflow) {
          res.writeHead(400, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: false, error: "workflow is required" }));
          return;
        }
        const force = input.force === true;
        const stopped = await stopDaemons(workflow, force, dir);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: true, workflow, force, stopped }));
      } catch (e) {
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: false, error: errorMessage(e) }));
      }
      return;
    }

    // ============================================================
    // Dashboard ops endpoints — retry, edit-and-resume, queue
    // mutations, daemon ops. All workflow-agnostic; each takes
    // `workflow` in the body / query and operates on tracker / queue
    // / daemon-registry files keyed by that workflow.
    // ============================================================

    /**
     * Read & parse a JSON body off the request, with a hard size cap to
     * keep the SSE server from being swamped by an unbounded POST. Used
     * by every operations endpoint below.
     */
    const readJsonBody = async (
      maxBytes = 64_536,
    ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
          if (Buffer.concat(chunks).byteLength > maxBytes) {
            return { ok: false, error: "Request body too large" };
          }
        }
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) return { ok: true, body: {} };
        return { ok: true, body: JSON.parse(raw) as Record<string, unknown> };
      } catch {
        return { ok: false, error: "Invalid JSON body" };
      }
    };

    const writeJson = (statusCode: number, body: unknown): void => {
      res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(body));
    };

    if (req.method === "POST" && url.pathname === "/api/retry") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const result = await buildRetryHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
        runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
      });
      writeJson(result.ok ? 202 : 400, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/retry-bulk") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const ids = Array.isArray(parsed.body.ids)
        ? (parsed.body.ids as unknown[]).map(String)
        : [];
      const result = await buildRetryBulkHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        ids,
      });
      writeJson(202, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run-with-data") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const data =
        parsed.body.data && typeof parsed.body.data === "object"
          ? (parsed.body.data as Record<string, unknown>)
          : {};
      const result = await buildRunWithDataHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
        runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
        data,
      });
      writeJson(result.ok ? 202 : 400, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cancel-queued") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const result = await buildCancelQueuedHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
      });
      const status = result.ok ? 200 : (result.status ?? 400);
      writeJson(status, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/queue/bump") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const result = await buildQueueBumpHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
      });
      const status = result.ok ? 200 : (result.status ?? 400);
      writeJson(status, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/daemons") {
      const workflow = url.searchParams.get("workflow") ?? undefined;
      const list = await buildDaemonsListHandler(dir)(workflow ?? undefined);
      writeJson(200, list);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/daemons/spawn") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const count = typeof parsed.body.count === "number" ? parsed.body.count : 1;
      // Spawn is fire-and-forget — Duo can take up to 5min and we don't want
      // to hold an HTTP connection open for that long. Frontend re-polls
      // /api/daemons to discover the new daemon as it comes online.
      const handler = buildDaemonsSpawnHandler(dir);
      void handler({
        workflow: String(parsed.body.workflow ?? ""),
        count,
      }).catch((err) => {
        log.error(`[POST /api/daemons/spawn] background spawn failed: ${errorMessage(err)}`);
      });
      writeJson(202, { ok: true, queued: count });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/daemons/stop") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const result = await buildDaemonsStopHandler(dir)({
        workflow: parsed.body.workflow ? String(parsed.body.workflow) : undefined,
        force: parsed.body.force === true,
      });
      writeJson(200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/events/daemon-log") {
      const pidStr = url.searchParams.get("pid") ?? "";
      const pid = Number.parseInt(pidStr, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        return writeJson(400, { ok: false, error: "valid pid query param required" });
      }
      const path = await resolveDaemonLogPath(pid, dir);
      if (!path) {
        return writeJson(404, { ok: false, error: "no log file for that pid" });
      }
      // SSE stream of log lines. Read existing tail (last 4KB) immediately,
      // then watchFile() for appends.
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      let bytesSent = 0;
      try {
        const stat = statSync(path);
        const tailBytes = Math.min(stat.size, 4096);
        const startAt = Math.max(0, stat.size - tailBytes);
        const stream = createReadStream(path, { start: startAt, end: stat.size });
        for await (const chunk of stream) {
          for (const line of String(chunk).split("\n")) {
            if (!line) continue;
            res.write(`data: ${JSON.stringify({ line, ts: new Date().toISOString() })}\n\n`);
          }
        }
        bytesSent = stat.size;
      } catch {
        /* ignore — file may be empty */
      }
      const onChange = (curr: { size: number }): void => {
        if (curr.size <= bytesSent) return;
        try {
          const stream = createReadStream(path, { start: bytesSent, end: curr.size });
          let buffered = "";
          stream.on("data", (chunk) => {
            buffered += String(chunk);
          });
          stream.on("end", () => {
            for (const line of buffered.split("\n")) {
              if (!line) continue;
              res.write(`data: ${JSON.stringify({ line, ts: new Date().toISOString() })}\n\n`);
            }
            bytesSent = curr.size;
          });
        } catch {
          /* ignore */
        }
      };
      watchFile(path, { interval: 500 }, onChange);
      req.on("close", () => {
        unwatchFile(path, onChange);
        res.end();
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/queue-depth") {
      // Per-workflow queue depth. Used by TopBar's queue-depth pill.
      // Returns: { [workflow]: number }
      const workflows = listWorkflows(dir);
      const result: Record<string, number> = {};
      for (const wf of workflows) {
        result[wf] = readQueueDepth(wf, dir);
      }
      writeJson(200, result);
      return;
    }

    if (url.pathname === "/api/preflight") {
      // 30-day floor so the operator always has at least the last month
      // of workflow history + screenshots available for retro investigation.
      const deleted = cleanOldTrackerFiles(30, dir);
      const deletedShots = cleanOldScreenshots(30);

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
        { name: "Old logs cleaned", passed: true, detail: `${deleted} file${deleted !== 1 ? "s" : ""} removed (> 30 days)` },
        { name: "Old screenshots cleaned", passed: true, detail: `${deletedShots} screenshot${deletedShots !== 1 ? "s" : ""} removed (> 30 days)` },
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
