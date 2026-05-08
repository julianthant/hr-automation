import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DIR, dateLocal } from "./jsonl.js";
import { getLogRunId } from "../utils/log.js";
import { appendJsonlWithSource } from "./state/jsonl-source.js";
import { applySessionEventLive } from "./state/runtime.js";
import { isStateDbReady, openStateDb } from "./state/db.js";

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
  | "item_start" | "item_complete"
  | "step_change"
  | "screenshot"
  | "telegram_sent";

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
  /** OS pid of the Chromium process for `browser_launch` events. Lets the
   * dashboard's force-stop path SIGKILL orphaned browsers when the Node
   * parent dies. Only populated for `type === "browser_launch"`. */
  chromiumPid?: number;
}

// ── File paths ─────────────────────────────────────────
//
// Sessions rotate into dated files (`sessions-YYYY-MM-DD.jsonl`) the same
// way tracker entries do. Reads aggregate every dated file plus a legacy
// single `sessions.jsonl` written before rotation landed; that legacy
// file ages out via `cleanOldSessionFiles` like any other dated file.

const LEGACY_SESSIONS_FILE = "sessions.jsonl";
const SESSIONS_PREFIX = "sessions-";
const SESSIONS_SUFFIX = ".jsonl";
const SESSIONS_DATE_RE = /^sessions-\d{4}-\d{2}-\d{2}\.jsonl$/;

export function getSessionsFilePath(dir: string = DEFAULT_DIR): string {
  return getSessionsFilePathForDate(dateLocal(), dir);
}

export function getSessionsFilePathForDate(
  date: string,
  dir: string = DEFAULT_DIR,
): string {
  return join(dir, `${SESSIONS_PREFIX}${date}${SESSIONS_SUFFIX}`);
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
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(
      // Strict YYYY-MM-DD dated names + the single legacy file. Loose
      // `sessions-*.jsonl` would slurp editor temp files / malformed dates
      // that `cleanOldSessionFiles` correctly refuses to delete, leaving
      // them to accumulate.
      (f) => f === LEGACY_SESSIONS_FILE || SESSIONS_DATE_RE.test(f),
    );
  } catch {
    return out; // dir doesn't exist
  }
  // Sort by date for deterministic ordering. Legacy file sorts first
  // (no date in its name; treat as oldest).
  files.sort();
  for (const f of files) {
    const path = join(dir, f);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as SessionEvent);
      } catch {
        // Skip malformed lines — same tolerance as the prior implementation.
      }
    }
  }
  return out;
}

// ── Convenience helpers ────────────────────────────────
//
// All accept an optional `dir` so callers (chiefly `withTrackedWorkflow`) can
// route session events to the same tracker dir they're using for entries +
// logs. Without this, tests that pass `trackerDir: TMP_DIR` for their
// per-workflow JSONL would still leak `workflow_start`/`step_change`/etc.
// into the real `.tracker/sessions.jsonl` and pollute the dashboard's
// dashboard session drawer with dead test instances.

export function emitWorkflowStart(instance: string, dir?: string): void {
  emitSessionEvent({ type: "workflow_start", workflowInstance: instance }, dir);
}

export function emitWorkflowEnd(instance: string, finalStatus?: "done" | "failed", dir?: string): void {
  emitSessionEvent({ type: "workflow_end", workflowInstance: instance, finalStatus }, dir);
}

const STEP_LOG_DEDUPE_WINDOW_MS = 50;
const STEP_LOG_TAIL_BYTES = 2048;

/**
 * Dedupe `step_change` session events against `step` log entries written
 * within the last 50ms for the same (runId, step). Prefers a constant-time
 * SQLite seek on idx_logs_item_run when projection is ready; falls back to
 * a bounded-byte tail read of today's logs JSONL otherwise.
 *
 * The previous "tail-read" implementation was a `readFileSync` of the full
 * `*-logs.jsonl` followed by `.split("\n")` and a tail-slice — by midday on
 * a busy daemon that was multi-MB-per-`markStep` × N workflow files. The
 * current impl reads at most ~2 KB (or the full file if smaller) via
 * `openSync`/`readSync`, which covers far more than the 50ms window can
 * produce.
 */
function recentStepLogExists(
  workflow: string,
  runId: string,
  step: string,
  dir: string,
): boolean {
  const cutoffMs = Date.now() - STEP_LOG_DEDUPE_WINDOW_MS;

  // SQLite path — uses idx_logs_item_run (workflow, tracker_date, item_id,
  // run_id, ts_ms). We don't have item_id from the caller (emitStepChange
  // has only workflow + runId), so we filter by (workflow, tracker_date,
  // run_id, ts_ms >= cutoff, level = 'step') and let SQLite pick the index.
  // run_id is highly selective on its own, and ts_ms >= cutoff limits the
  // scan to the last 50ms of rows.
  if (isStateDbReady(dir)) {
    try {
      const db = openStateDb(dir);
      const row = db.prepare(`
        SELECT 1
        FROM logs
        WHERE workflow = @workflow
          AND tracker_date = @date
          AND run_id = @runId
          AND level = 'step'
          AND ts_ms >= @cutoff
          AND message LIKE '%' || @step || '%'
        LIMIT 1
      `).get({
        workflow,
        date: dateLocal(),
        runId,
        cutoff: cutoffMs,
        step,
      });
      return row !== undefined;
    } catch {
      // Fall through to JSONL path on any SQLite hiccup.
    }
  }

  // JSONL fallback — bounded byte tail read of today's logs file. ~2 KB
  // covers the last ~10–20 lines, which is far more than the 50ms window
  // can produce. Avoids the multi-MB readFileSync the previous impl did.
  const path = join(dir, `${workflow}-${dateLocal()}-logs.jsonl`);
  let stat;
  try { stat = statSync(path); } catch { return false; }
  const tailBytes = Math.min(stat.size, STEP_LOG_TAIL_BYTES);
  if (tailBytes === 0) return false;
  let tail: string;
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(tailBytes);
      readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
      tail = buf.toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  // Drop the first (possibly partial) line if we didn't seek to a newline
  // boundary (i.e. the file is bigger than our tail window).
  const firstNl = tail.indexOf("\n");
  const lines = firstNl >= 0 && stat.size > tailBytes
    ? tail.slice(firstNl + 1).split("\n")
    : tail.split("\n");
  for (const line of lines) {
    if (!line) continue;
    try {
      const log = JSON.parse(line);
      if (
        log.runId === runId &&
        log.level === "step" &&
        typeof log.message === "string" &&
        log.message.includes(step) &&
        new Date(log.ts).getTime() >= cutoffMs
      ) {
        return true;
      }
    } catch { /* skip malformed line */ }
  }
  return false;
}

export function emitStepChange(instance: string, step: string, dir?: string): void {
  const resolvedDir = dir ?? DEFAULT_DIR;
  const runId = getLogRunId();
  if (runId) {
    // Scan all today's *-logs.jsonl files in resolvedDir (since we don't have
    // the workflow name here, only the instance label). Constant-cost: each
    // scan reads the tail of one or two small JSONL files.
    let workflowFiles: string[] = [];
    const dateSuffix = `-${dateLocal()}-logs.jsonl`;
    try {
      workflowFiles = readdirSync(resolvedDir).filter((f) => f.endsWith(dateSuffix));
    } catch { /* dir might not exist yet */ }
    for (const f of workflowFiles) {
      const wf = f.slice(0, f.length - dateSuffix.length);
      if (recentStepLogExists(wf, runId, step, resolvedDir)) {
        return; // dedupe
      }
    }
  }
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

export function emitItemStart(instance: string, itemId: string, dir?: string): void {
  emitSessionEvent({ type: "item_start", workflowInstance: instance, currentItemId: itemId }, dir);
}

export function emitItemComplete(instance: string, itemId: string, dir?: string): void {
  emitSessionEvent({ type: "item_complete", workflowInstance: instance, currentItemId: itemId }, dir);
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
  "eid-lookup": "EID Lookup",
  "kronos-reports": "Kronos",
  "work-study": "Work Study",
  "emergency-contact": "Emergency Contact",
  "sharepoint-download": "SharePoint Download",
  "oath-signature": "Oath Signature",
  "oath-upload": "Oath Upload",
  "active-check": "Active Check",
  ocr: "OCR",
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

/** Generate a unique instance name like "Separation 1", "Separation 2", etc. */
export function generateInstanceName(workflowType: string, dir?: string): string {
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
    if (s <= e) break;
    n++;
  }
  return `${label} ${n}`;
}
