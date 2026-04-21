import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { DEFAULT_DIR } from "./jsonl.js";
import { getLogRunId } from "../utils/log.js";

// ── Types ──────────────────────────────────────────────

/**
 * Structured events emitted by the kernel during workflow execution.
 *
 * Originally scoped to session/browser/auth lifecycle. As of 2026-04-19 also
 * carries step-execution annotations (e.g. `cache_hit`) that are no-ops for
 * `rebuildSessionState` but appear in the dashboard's Events tab via the
 * `/events/run-events` SSE.
 *
 * If a third non-lifecycle event lands, consider renaming to KernelEventType.
 */
export type SessionEventType =
  | "workflow_start" | "workflow_end"
  | "session_create" | "session_close"
  | "browser_launch" | "browser_close"
  | "auth_start" | "auth_complete" | "auth_failed"
  | "duo_request" | "duo_start" | "duo_complete" | "duo_timeout"
  | "item_start" | "item_complete"
  | "step_change"
  | "cache_hit"
  | "screenshot";

export interface ScreenshotSessionEvent {
  type: "screenshot";
  runId: string;
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
  /** Step name for step-scoped events like cache_hit. */
  step?: string;
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
  instance: string, sessionId: string, browserId: string, system: string, dir?: string,
): void {
  emitSessionEvent({ type: "browser_launch", workflowInstance: instance, sessionId, browserId, system }, dir);
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

export function emitCacheHit(
  workflowInstance: string,
  itemId: string,
  step: string,
  dir?: string,
): void {
  emitSessionEvent({
    type: "cache_hit",
    workflowInstance,
    currentItemId: itemId,
    step,
  }, dir);
}

// ── Instance naming ────────────────────────────────────

/** Generate a unique instance name like "Separation 1", "Separation 2", etc. */
export function generateInstanceName(workflowType: string): string {
  const labels: Record<string, string> = {
    onboarding: "Onboarding",
    separations: "Separation",
    "eid-lookup": "EID Lookup",
    "kronos-reports": "Kronos",
    "work-study": "Work Study",
    "emergency-contact": "Emergency Contact",
  };
  const label = labels[workflowType] || workflowType;

  const events = readSessionEvents();
  // Count starts and ends per instance name. A name is "active" when it has
  // been started more times than it has ended (handles re-use across sessions).
  const startCount = new Map<string, number>();
  const endCount = new Map<string, number>();
  for (const e of events) {
    if (e.type === "workflow_start") {
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
    // Name is available if it was never started, or all starts have been ended
    if (s <= e) break;
    n++;
  }
  return `${label} ${n}`;
}
