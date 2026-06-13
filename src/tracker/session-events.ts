import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DIR, dateLocal } from "./jsonl.js";
import {
  parseSessionFilename,
  sessionFilePath,
  sessionsDir,
} from "./paths.js";
import { getLogRunId } from "../utils/log-context.js";
import { appendJsonlWithSource } from "./state/jsonl-source.js";
import { applySessionEventLive } from "./state/runtime.js";

// ── Types ──────────────────────────────────────────────

/**
 * Structured events emitted by the kernel during workflow execution.
 * Session/browser/auth/item lifecycle + per-step step_change + screenshot.
 */
export type SessionEventType =
  | "workflow_start" | "workflow_end"
  | "session_create" | "session_close"
  | "browser_launch" | "browser_close"
  | "auth_start" | "auth_complete" | "auth_failed"
  | "duo_request" | "duo_start" | "duo_complete" | "duo_timeout"
  | "item_start" | "item_complete" | "item_cancelled"
  | "step_change"
  | "screenshot"
  | "idle_signal"
  | "daemon_phase"
  | "daemon_log";

export interface ScreenshotSessionEvent {
  type: "screenshot";
  runId: string;
  /** ISO-8601 timestamp. Mirrors SessionEvent.timestamp so the dashboard
   * doesn't see "Invalid Date" when it renders screenshot events alongside
   * other session events (which use `timestamp`). Populated from the same
   * clock as `ts`. */
  timestamp: string;
  /** Numeric ms since epoch. Kept for back-compat with existing readers
   * and to uniquely identify the capture alongside `label` + `system`
   * inside filenames. */
  ts: number;
  kind: "form" | "error" | "manual";
  label: string;
  step: string | null;
  files: Array<{ system: string; path: string }>;
}

export interface SessionEvent {
  type: SessionEventType;
  timestamp: string;
  pid: number;
  workflowInstance: string;
  sessionId?: string;
  browserId?: string;
  system?: string;
  currentItemId?: string;
  currentStep?: string;
  finalStatus?: "done" | "failed";
  duoRequestId?: string;
  data?: Record<string, string>;
  /** Workflow item runId, written when emitted inside a withLogContext + setLogRunId scope. */
  runId?: string;
  /** Frozen `data.__traceId` of the item's run, carried on `item_start` so the
   * session-drawer card can show the running run's trace id — identical to the
   * subtitle of that run's queue row. */
  traceId?: string;
  /** OS pid of the Chromium process for `browser_launch` events. Lets the
   * dashboard's force-stop path SIGKILL orphaned browsers when the Node
   * parent dies. Only populated for `type === "browser_launch"`. */
  chromiumPid?: number;
}

// ── File paths ─────────────────────────────────────────
//
// Sessions rotate into dated files under the `sessions/` subdirectory
// (`<dir>/sessions/YYYY-MM-DD.jsonl`). Reads aggregate every dated file in
// that directory. Path construction lives in `paths.ts`.

// ── readSessionEvents cache ────────────────────────────────
// Session files are append-only. Cache parsed events per file by
// (mtimeMs, size). If both match the cached entry, skip re-parsing.
// Cap at 64 entries with LRU eviction (delete-on-hit + re-set) so long-lived
// dashboard sessions walking historical dated files don't leak unboundedly.
// `cleanOldSessionFiles` removes the files but not cache entries, so without
// a cap the parsed arrays for old dates accumulate for the process lifetime.
interface SessionFileCache {
  mtimeMs: number;
  size: number;
  events: SessionEvent[];
}
const SESSION_EVENTS_CACHE_MAX = 64;
const sessionEventsCache = new Map<string, SessionFileCache>();

/** Test-only: clear the module-level session-events file cache. */
export function __resetSessionEventsCacheForTests(): void {
  sessionEventsCache.clear();
}

export function getSessionsFilePath(dir: string = DEFAULT_DIR): string {
  return getSessionsFilePathForDate(dateLocal(), dir);
}

export function getSessionsFilePathForDate(
  date: string,
  dir: string = DEFAULT_DIR,
): string {
  return sessionFilePath(date, dir);
}

// ── Read / Write ───────────────────────────────────────

export function emitSessionEvent(
  event: Omit<SessionEvent, "timestamp" | "pid">,
  dir: string = DEFAULT_DIR,
): void {
  const runId = event.runId ?? getLogRunId();
  const full: SessionEvent = {
    ...event,
    ...(runId ? { runId } : {}),
    timestamp: new Date().toISOString(),
    pid: process.pid,
  };
  // Route to the dated file matching `full.timestamp`'s local date — same
  // rule tracker entries follow (see `dateLocal(new Date(entry.timestamp))`
  // in jsonl.ts:trackEvent). Keeps batch-scope events emitted near local
  // midnight in the same file as the per-item rows from the same run.
  const trackerDate = dateLocal(new Date(full.timestamp));
  const path = getSessionsFilePathForDate(trackerDate, dir);
  const source = appendJsonlWithSource(path, full, {
    sourceKind: "session",
    trackerDate,
  });
  applySessionEventLive(full, source, dir);
}

export function readSessionEvents(dir: string = DEFAULT_DIR): SessionEvent[] {
  const out: SessionEvent[] = [];
  const sessions = sessionsDir(dir);
  let files: string[];
  try {
    files = readdirSync(sessions).filter((f) => parseSessionFilename(f) !== null);
  } catch {
    return out; // dir doesn't exist
  }
  // Sort by date (filename is `YYYY-MM-DD.jsonl`) for deterministic ordering.
  files.sort();
  for (const f of files) {
    const filePath = join(sessions, f);
    let stat: { mtimeMs: number; size: number };
    try {
      stat = statSync(filePath);
    } catch {
      continue; // file disappeared between readdirSync and statSync
    }
    const cached = sessionEventsCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      // File unchanged — bump to most-recent (LRU hit) and reuse.
      sessionEventsCache.delete(filePath);
      sessionEventsCache.set(filePath, cached);
      for (const ev of cached.events) out.push(ev);
      continue;
    }
    // Parse and populate cache.
    const events: SessionEvent[] = [];
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch {
        // Skip malformed lines.
      }
    }
    // Delete-then-set bumps insertion-order position for the LRU eviction.
    sessionEventsCache.delete(filePath);
    sessionEventsCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, events });
    if (sessionEventsCache.size > SESSION_EVENTS_CACHE_MAX) {
      const oldestKey = sessionEventsCache.keys().next().value;
      if (oldestKey !== undefined) sessionEventsCache.delete(oldestKey);
    }
    for (const ev of events) out.push(ev);
  }
  return out;
}

// ── Convenience helpers ────────────────────────────────
//
// All accept an optional `dir` so callers (chiefly `withTrackedWorkflow`) can
// route session events to the same tracker dir they're using for entries +
// logs. Without this, tests that pass `trackerDir: TMP_DIR` for their
// per-workflow JSONL would still leak `workflow_start`/`step_change`/etc.
// into the real `.tracker/` session files and pollute the dashboard's
// dashboard session drawer with dead test instances.

export function emitWorkflowStart(instance: string, dir?: string): void {
  emitSessionEvent({ type: "workflow_start", workflowInstance: instance }, dir);
}

export function emitWorkflowEnd(instance: string, finalStatus?: "done" | "failed", dir?: string): void {
  emitSessionEvent({ type: "workflow_end", workflowInstance: instance, finalStatus }, dir);
}

/**
 * Emit a `step_change` session event. This is the ONLY carrier of a daemon's
 * live `currentStep` — `rebuildSessionState` derives `WorkflowInstanceState.
 * currentStep` solely from these events, which in turn drives the session
 * card's footer step text + micro step pipeline.
 *
 * The `workflow` arg is retained for caller compatibility but no longer used:
 * a previous "dedupe against a recent `step:start` log within 50ms" guard
 * lived here, but `Stepper.announce` writes that very `step:start` log
 * IMMEDIATELY before calling this — so the guard matched on every `ctx.step`
 * and suppressed the event for the whole run, leaving `currentStep` null and
 * the session card stuck showing the item id instead of the step. The
 * duplicate-line concern it was solving (the log-panel "all" tab showing both
 * the `Phase: X` log line and the `step_change` event line) is now handled at
 * render time in `mergeDisplayItems` (LogStream), which drops the redundant
 * `step_change` events from the merged view while keeping them in the
 * dedicated Events tab — and, crucially, keeps them flowing to session state.
 */
export function emitStepChange(instance: string, step: string, dir?: string, _workflow?: string): void {
  const resolvedDir = dir ?? DEFAULT_DIR;
  emitSessionEvent({ type: "step_change", workflowInstance: instance, currentStep: step }, resolvedDir);
}

export function emitSessionCreate(instance: string, sessionId: string, dir?: string): void {
  emitSessionEvent({ type: "session_create", workflowInstance: instance, sessionId }, dir);
}

export function emitSessionClose(instance: string, sessionId: string, dir?: string): void {
  emitSessionEvent({ type: "session_close", workflowInstance: instance, sessionId }, dir);
}

export function emitBrowserLaunch(
  instance: string,
  sessionId: string,
  browserId: string,
  system: string,
  dir?: string,
  chromiumPid?: number,
): void {
  emitSessionEvent(
    {
      type: "browser_launch",
      workflowInstance: instance,
      sessionId,
      browserId,
      system,
      ...(typeof chromiumPid === "number" ? { chromiumPid } : {}),
    },
    dir,
  );
}

export function emitBrowserClose(instance: string, browserId: string, system: string, dir?: string): void {
  emitSessionEvent({ type: "browser_close", workflowInstance: instance, browserId, system }, dir);
}

export function emitAuthStart(instance: string, browserId: string, system: string, dir?: string): void {
  emitSessionEvent({ type: "auth_start", workflowInstance: instance, browserId, system }, dir);
}

export function emitAuthComplete(instance: string, browserId: string, system: string, dir?: string): void {
  emitSessionEvent({ type: "auth_complete", workflowInstance: instance, browserId, system }, dir);
}

export function emitAuthFailed(instance: string, browserId: string, system: string, dir?: string): void {
  emitSessionEvent({ type: "auth_failed", workflowInstance: instance, browserId, system }, dir);
}

export type IdleSignalKind = "touch" | "refresh_start" | "refresh_end";

/**
 * Dashboard idle-refresh ring — per-system touch/reload lifecycle. `system` is
 * the idle-refresh system id (`ucpath`, `i9`, …); keep kinds aligned with
 * `rebuildSessionState`. See `src/domain/idle-refresh.ts`.
 */
export function emitIdleSignal(
  instance: string,
  dir: string | undefined,
  system: string,
  kind: IdleSignalKind,
): void {
  emitSessionEvent(
    { type: "idle_signal", workflowInstance: instance, system, data: { kind } },
    dir,
  );
}

/** Daemon drawer status — only `idle` and `keepalive` are emitted (low noise). */
export function emitDaemonPhase(instance: string, phase: "idle" | "keepalive", dir?: string): void {
  emitSessionEvent(
    { type: "daemon_phase", workflowInstance: instance, data: { phase } },
    dir,
  );
}

/**
 * A log line the daemon writes about itself (startup, claim loop, shutdown).
 * Stored in the session log because it is machine-scoped, not tied to one run.
 * `level` is the log level: "step"|"success"|"warn"|"error"|"waiting"|"debug".
 */
export function emitDaemonLog(
  instance: string,
  level: string,
  message: string,
  dir?: string,
  data: Record<string, string> = {},
): void {
  emitSessionEvent(
    { type: "daemon_log", workflowInstance: instance, data: { level, message, ...data } },
    dir,
  );
}

export function emitItemStart(
  instance: string,
  itemId: string,
  dir?: string,
  runId?: string,
  traceId?: string,
): void {
  emitSessionEvent({
    type: "item_start",
    workflowInstance: instance,
    currentItemId: itemId,
    ...(runId ? { runId } : {}),
    ...(traceId ? { traceId } : {}),
  }, dir);
}

export function emitItemComplete(instance: string, itemId: string, dir?: string, runId?: string): void {
  emitSessionEvent({
    type: "item_complete",
    workflowInstance: instance,
    currentItemId: itemId,
    ...(runId ? { runId } : {}),
  }, dir);
}

/**
 * Emit a cancellation event for the Events tab. The reason is carried in
 * `data.reason` so the dashboard can render it inline (e.g. "cancelled by
 * user from dashboard", "Daemon stopped while processing this item",
 * "browser closed"). Surface the cancellation as a session event rather
 * than a warn-level log entry so the operator sees it under the Events
 * filter, distinct from arrow-icon step logs.
 */
export function emitItemCancelled(
  instance: string,
  itemId: string,
  reason: string,
  dir?: string,
  runId?: string,
): void {
  emitSessionEvent({
    type: "item_cancelled",
    workflowInstance: instance,
    currentItemId: itemId,
    data: { reason },
    ...(runId ? { runId } : {}),
  }, dir);
}


// ── Instance naming ────────────────────────────────────

/**
 * True if `pid` belongs to a live process. Uses `process.kill(pid, 0)` which
 * only raises ESRCH if no such process exists. Returns `false` on any error
 * — we conservatively treat permission denials (EPERM) as dead so stale
 * orphans from other users/containers don't block instance numbering.
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const STALE_START_THRESHOLD_MS = 60_000;

/** Maps kebab-case workflow name → human-readable instance label prefix. */
export const INSTANCE_LABELS: Record<string, string> = {
  onboarding: "Onboarding",
  separations: "Separation",
  "person-lookup": "Person Lookup",
  "kronos-reports": "Kronos",
  "work-study": "Work Study",
  "emergency-contact": "Emergency Contact",
  "sharepoint-download": "SharePoint Download",
  "crm-doc-download": "CRM Doc Download",
  "oath-signature": "Oath Signature",
  "oath-upload": "Oath Upload",
  ocr: "OCR",
  "i9-lookup": "I9 Lookup",
};

/**
 * Reverse of `INSTANCE_LABELS`. Given an instance name like "Separation 1",
 * strip the trailing number and resolve back to the kebab-case workflow
 * name ("separations"). Returns null when the label is unrecognised.
 */
export function workflowNameFromInstance(instance: string): string | null {
  const stripped = instance.replace(/\s+\d+$/, "").trim();
  if (Object.prototype.hasOwnProperty.call(INSTANCE_LABELS, stripped)) {
    return stripped;
  }
  for (const [wf, label] of Object.entries(INSTANCE_LABELS)) {
    if (label === stripped) return wf;
  }
  return null;
}

/**
 * Generate a unique instance name like "Separation 1", "Separation 2", etc.
 *
 * `reservedNames` is a caller-supplied set of names already claimed by alive
 * peers whose `workflow_start` may not be on disk yet (VS-003): a daemon
 * allocates its session-drawer name at lockfile-write time — BEFORE it emits
 * `workflow_start` — and stores it in the lockfile so a concurrently-spawning
 * peer can scan alive lockfiles and pass the discovered names here. A slot is
 * occupied when EITHER the session-event count says so OR it is in
 * `reservedNames`, so two near-simultaneous daemons never both pick "<wf> 1".
 */
export function generateInstanceName(
  workflowType: string,
  dir?: string,
  reservedNames?: ReadonlySet<string>,
): string {
  const label = INSTANCE_LABELS[workflowType] || workflowType;

  const events = readSessionEvents(dir);
  // Count starts and ends per instance name. A `workflow_start` is effectively
  // "ended" (ignored) when its pid is dead AND its timestamp is older than the
  // stale-start threshold — this self-heals crashed runs whose SIGINT never
  // emitted `workflow_end` (e.g. a `kill -9` or an exit before the handler
  // ran). Fresh orphans (<60 s old) still block the slot so a legitimately
  // in-flight run isn't stepped on by a parallel start.
  const startCount = new Map<string, number>();
  const endCount = new Map<string, number>();
  const now = Date.now();
  for (const e of events) {
    if (e.type === "workflow_start") {
      const ts = Date.parse(e.timestamp);
      const ageMs = Number.isFinite(ts) ? now - ts : 0;
      const stale = ageMs > STALE_START_THRESHOLD_MS && !isPidAlive(e.pid);
      if (stale) continue;
      startCount.set(e.workflowInstance, (startCount.get(e.workflowInstance) ?? 0) + 1);
    }
    if (e.type === "workflow_end") {
      endCount.set(e.workflowInstance, (endCount.get(e.workflowInstance) ?? 0) + 1);
    }
  }

  let n = 1;
  while (true) {
    const name = `${label} ${n}`;
    const s = startCount.get(name) ?? 0;
    const e = endCount.get(name) ?? 0;
    const free = s <= e && !reservedNames?.has(name);
    if (free) break;
    n++;
  }
  return `${label} ${n}`;
}
