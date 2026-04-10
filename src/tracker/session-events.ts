import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { DEFAULT_DIR } from "./jsonl.js";

// ── Types ──────────────────────────────────────────────

export type SessionEventType =
  | "workflow_start" | "workflow_end"
  | "session_create" | "session_close"
  | "browser_launch" | "browser_close"
  | "auth_start" | "auth_complete" | "auth_failed"
  | "duo_request" | "duo_start" | "duo_complete" | "duo_timeout"
  | "item_start" | "item_complete";

export interface SessionEvent {
  type: SessionEventType;
  timestamp: string;
  pid: number;
  workflowInstance: string;
  sessionId?: string;
  browserId?: string;
  system?: string;
  currentItemId?: string;
  duoRequestId?: string;
  data?: Record<string, string>;
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
  const full: SessionEvent = {
    ...event,
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

export function emitWorkflowStart(instance: string): void {
  emitSessionEvent({ type: "workflow_start", workflowInstance: instance });
}

export function emitWorkflowEnd(instance: string): void {
  emitSessionEvent({ type: "workflow_end", workflowInstance: instance });
}

export function emitSessionCreate(instance: string, sessionId: string): void {
  emitSessionEvent({ type: "session_create", workflowInstance: instance, sessionId });
}

export function emitSessionClose(instance: string, sessionId: string): void {
  emitSessionEvent({ type: "session_close", workflowInstance: instance, sessionId });
}

export function emitBrowserLaunch(
  instance: string, sessionId: string, browserId: string, system: string,
): void {
  emitSessionEvent({ type: "browser_launch", workflowInstance: instance, sessionId, browserId, system });
}

export function emitBrowserClose(instance: string, browserId: string, system: string): void {
  emitSessionEvent({ type: "browser_close", workflowInstance: instance, browserId, system });
}

export function emitAuthStart(instance: string, browserId: string, system: string): void {
  emitSessionEvent({ type: "auth_start", workflowInstance: instance, browserId, system });
}

export function emitAuthComplete(instance: string, browserId: string, system: string): void {
  emitSessionEvent({ type: "auth_complete", workflowInstance: instance, browserId, system });
}

export function emitAuthFailed(instance: string, browserId: string, system: string): void {
  emitSessionEvent({ type: "auth_failed", workflowInstance: instance, browserId, system });
}

export function emitItemStart(instance: string, itemId: string): void {
  emitSessionEvent({ type: "item_start", workflowInstance: instance, currentItemId: itemId });
}

export function emitItemComplete(instance: string, itemId: string): void {
  emitSessionEvent({ type: "item_complete", workflowInstance: instance, currentItemId: itemId });
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
