/**
 * DEV-ONLY — the EXECUTOR half of the wire contract: what workers exist, and
 * what happens when you ask for more of them.
 *
 * The Session Panel's `+` starts N workers for one workflow. There is no
 * capacity gate on that ask: pick a workflow, pick a count, start them.
 *
 * Workers own concrete browser sessions. The Session Card renders those as
 * health tiles, not lane or per-system capacity counters; a workflow declares
 * any step that must start in a new browser session.
 */

import { DEMO_WORKFLOWS, DEMO_WORKFLOW_LIST, type DemoWorkflowId, type SystemKey } from "./demo-wire";

// ---------------------------------------------------------------------------
// What a worker IS, as the Session Panel renders it
// ---------------------------------------------------------------------------

/** `unknown` = never probed. It must NOT read as healthy — that is a live bug today. */
export type BrowserHealth = "healthy" | "refreshing" | "unhealthy" | "failed" | "paused" | "unknown";
export type SessionPhase = "authenticating" | "running" | "idle" | "keepalive" | "complete" | "failed";

export interface DemoBrowser {
  id: string;
  label: string;
  health: BrowserHealth;
  url: string;
}

/**
 * Why this executor is not progressing. Named lease + holder turns "nothing is
 * happening" into something you can act on. This is NOT used to refuse spawn —
 * a second worker may open its own UCPath window even while another worker
 * already holds one.
 */
export interface DemoLeaseWait {
  system: string;
  sinceSec: number;
  heldByWorkflow: string;
  heldByTrace: string;
}

export interface DemoSession {
  id: string;
  workflow: string;
  phase: SessionPhase;
  /** shown only while an item is in flight — a retained trace id on an idle card reads as stale */
  traceId?: string;
  step?: string;
  subline: string;
  elapsedSec: number;
  browsers: DemoBrowser[];
  /** items waiting in the shared queue for this workflow */
  queued?: number;
  /** micro pipeline — one dot per step of the item in flight */
  steps?: { label: string; state: "done" | "current" | "pending" }[];
  crashed?: boolean;
  /** present when the executor is alive and NOT progressing */
  waiting?: DemoLeaseWait;
}

export const DEMO_SESSIONS: DemoSession[] = [
  {
    id: "s-sep",
    workflow: "Separations",
    phase: "running",
    traceId: "se-140211-9f3a",
    step: "UCPath transaction",
    subline: "se-140211-9f3a",
    elapsedSec: 1112,
    queued: 2,
    steps: [
      { label: "Kuali extraction", state: "done" },
      { label: "Identity check", state: "done" },
      { label: "Job summary", state: "done" },
      { label: "Kronos search", state: "done" },
      { label: "UCPath transaction", state: "current" },
      { label: "Kuali finalization", state: "pending" },
    ],
    browsers: [
      { id: "b1", label: "kuali", health: "healthy", url: "kuali.ucsd.edu/space/HR" },
      { id: "b2", label: "ucpath", health: "healthy", url: "ucpath.universityofcalifornia.edu" },
      { id: "b3", label: "kronos", health: "refreshing", url: "kronos.ucsd.edu/timekeeping" },
    ],
  },
  {
    // Own UCPath browser — Separations holding a UCPath window elsewhere does
    // not block this worker. Distinct browser sessions = distinct UCPath windows.
    id: "s-i9",
    workflow: "I-9 Check",
    phase: "running",
    traceId: "ic-134001-m31",
    step: "Person lookup",
    subline: "ic-134001-m31",
    elapsedSec: 2410,
    queued: 6,
    steps: [
      { label: "Person match", state: "done" },
      { label: "Person lookup", state: "current" },
      { label: "Roster match", state: "pending" },
    ],
    browsers: [
      { id: "b4", label: "ucpath", health: "healthy", url: "ucpath…/PersonSearch" },
      { id: "b4b", label: "i9", health: "healthy", url: "i9.ucsd.edu" },
    ],
  },
  {
    id: "s-ocr",
    workflow: "OCR",
    phase: "idle",
    subline: "idle — waiting for work",
    elapsedSec: 384,
    browsers: [{ id: "b5", label: "i9", health: "healthy", url: "i9.ucsd.edu" }],
  },
  {
    id: "s-oath",
    workflow: "Oath Signature",
    phase: "authenticating",
    subline: "Authenticating 1/2",
    elapsedSec: 41,
    browsers: [
      { id: "b6", label: "crm", health: "unhealthy", url: "stuck on the SSO login page" },
      { id: "b7", label: "ucpath", health: "paused", url: "auto-recovery paused by you" },
    ],
  },
  {
    id: "s-crm",
    workflow: "CRM Doc Download",
    phase: "failed",
    subline: "Check the queue row for details",
    elapsedSec: 0,
    crashed: true,
    browsers: [{ id: "b8", label: "crm", health: "failed", url: "about:blank" }],
  },
];

// ---------------------------------------------------------------------------
// Live-worker count — informational, never a spawn gate
// ---------------------------------------------------------------------------

export function liveWorkerCount(sessions: DemoSession[]): number {
  return sessions.filter((session) => !session.crashed).length;
}

export const DEMO_LIVE_WORKERS = liveWorkerCount(DEMO_SESSIONS);

// ---------------------------------------------------------------------------
// Spawn — workflow + count. No capacity refusals.
// ---------------------------------------------------------------------------

export interface WorkerSpawnOutcome {
  /** 1-based, so the vector reads "worker 3 of 5" without arithmetic */
  index: number;
  state: "started";
  instance: string;
  /** the systems this worker will open browsers for */
  claimed: string[];
}

export interface WorkerSpawnResult {
  workflowId: DemoWorkflowId;
  workflowLabel: string;
  requested: number;
  started: number;
  outcomes: WorkerSpawnOutcome[];
  headline: string;
}

/**
 * Soft UI bound for the stepper only — not a machine or lease ceiling.
 * The dialog does not refuse past this; it just stops counting up.
 */
export const MAX_WORKER_SPAWN = 20;

/**
 * Start `count` workers for `workflowId`. Every requested worker starts.
 *
 * There is no system-lease walk and no executor-pool gate. UCPath's per-worker
 * cap of 1 is satisfied by giving each new worker its own browser session.
 */
export function planWorkerSpawn(
  workflowId: DemoWorkflowId,
  count: number,
  liveExecutors: number = DEMO_LIVE_WORKERS,
): WorkerSpawnResult {
  const workflow = DEMO_WORKFLOWS[workflowId];
  const needs: SystemKey[] = workflow.systems;
  let ordinal = liveExecutors;

  const outcomes: WorkerSpawnOutcome[] = [];
  for (let i = 1; i <= count; i += 1) {
    ordinal += 1;
    outcomes.push({
      index: i,
      state: "started",
      instance: `${workflow.code}-w${ordinal}`,
      claimed: [...needs],
    });
  }

  return {
    workflowId,
    workflowLabel: workflow.label,
    requested: count,
    started: outcomes.length,
    outcomes,
    headline: `${outcomes.length} of ${count} started`,
  };
}

/** every workflow a worker can be started for, in the rail's own order */
export const WORKER_SPAWN_WORKFLOWS = DEMO_WORKFLOW_LIST;
