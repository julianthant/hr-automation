import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { DEFAULT_DIR } from "./jsonl.js";
import { getLogRunId } from "../utils/log.js";

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
  | "screenshot";

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

// ── File path ──────────────────────────────────────────

const SESSIONS_FILE = "sessions.jsonl";

export function getSessionsFilePath(dir: string = DEFAULT_DIR): string {
  return join(dir, SESSIONS_FILE);
}

// ── Read / Write ───────────────────────────────────────

export function emitSessionEvent(
  event: Omit<SessionEvent, "timestamp" | "pid">,
  dir: string = DEFAULT_DIR,
): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const runId = event.runId ?? getLogRunId();
  const full: SessionEvent = {
    ...event,
    ...(runId ? { runId } : {}),
    timestamp: new Date().toISOString(),
    pid: process.pid,
  };
  appendFileSync(getSessionsFilePath(dir), JSON.stringify(full) + "\n");
}

export function readSessionEvents(dir: string = DEFAULT_DIR): SessionEvent[] {
  const path = getSessionsFilePath(dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEvent);
}

// ── Convenience helpers ────────────────────────────────
//
// All accept an optional `dir` so callers (chiefly `withTrackedWorkflow`) can
// route session events to the same tracker dir they're using for entries +
// logs. Without this, tests that pass `trackerDir: TMP_DIR` for their
// per-workflow JSONL would still leak `workflow_start`/`step_change`/etc.
// into the real `.tracker/sessions.jsonl` and pollute the dashboard's
// SessionPanel with dead test instances.

export function emitWorkflowStart(instance: string, dir?: string): void {
  emitSessionEvent({ type: "workflow_start", workflowInstance: instance }, dir);
}

export function emitWorkflowEnd(instance: string, finalStatus?: "done" | "failed", dir?: string): void {
  emitSessionEvent({ type: "workflow_end", workflowInstance: instance, finalStatus }, dir);
}

const STEP_LOG_DEDUPE_WINDOW_MS = 50;

function recentStepLogExists(
  workflow: string,
  runId: string,
  step: string,
  dir: string,
): boolean {
  const date = new Date().toISOString().slice(0, 10);
  const path = join(dir, `${workflow}-${date}-logs.jsonl`);
  if (!existsSync(path)) return false;
  let content: string;
  try { content = readFileSync(path, "utf-8"); } catch { return false; }
  const lines = content.split("\n");
  // Walk last few lines (cheap; no need to read whole file for a 50ms window)
  const tail = lines.slice(Math.max(0, lines.length - 8));
  const cutoff = Date.now() - STEP_LOG_DEDUPE_WINDOW_MS;
  for (const line of tail) {
    if (!line) continue;
    try {
      const log = JSON.parse(line);
      if (
        log.runId === runId &&
        log.level === "step" &&
        typeof log.message === "string" &&
        log.message.includes(step) &&
        new Date(log.ts).getTime() >= cutoff
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
    try {
      const dateSuffix = `-${new Date().toISOString().slice(0, 10)}-logs.jsonl`;
      workflowFiles = readdirSync(resolvedDir).filter((f) => f.endsWith(dateSuffix));
    } catch { /* dir might not exist yet */ }
    for (const f of workflowFiles) {
      const dateSuffix = `-${new Date().toISOString().slice(0, 10)}-logs.jsonl`;
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
};

/**
 * Reverse of `INSTANCE_LABELS`. Given an instance name like "Separation 1",
 * strip the trailing number and resolve back to the kebab-case workflow
 * name ("separations"). Returns null when the label is unrecognised.
 */
export function workflowNameFromInstance(instance: string): string | null {
  const stripped = instance.replace(/\s+\d+$/, "").trim();
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
