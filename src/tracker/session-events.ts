import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
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
  | "cache_hit";

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

export function emitStepChange(instance: string, step: string, dir?: string): void {
  emitSessionEvent({ type: "step_change", workflowInstance: instance, currentStep: step }, dir);
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
  const starts = new Set<string>();
  const ends = new Set<string>();
  for (const e of events) {
    if (e.type === "workflow_start") starts.add(e.workflowInstance);
    if (e.type === "workflow_end") ends.add(e.workflowInstance);
  }

  let n = 1;
  while (starts.has(`${label} ${n}`) && !ends.has(`${label} ${n}`)) {
    n++;
  }
  return `${label} ${n}`;
}
