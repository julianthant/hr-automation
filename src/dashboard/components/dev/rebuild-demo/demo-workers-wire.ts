/**
 * DEV-ONLY — the EXECUTOR half of the wire contract: what workers exist, what
 * capacity they are holding, and what happens when you ask for more of them.
 *
 * The Session Panel's `+` was a NOOP. Making it real needed the thing the panel
 * was already rendering to become a MODEL rather than a set of card props: the
 * cards show per-worker lanes and per-system leases, so the answer to "can I
 * start five more Separations workers" is already on screen and the dialog must
 * not derive it a second way.
 *
 * So the fixture lives here, `DEMO_LANE_BUDGET` is DERIVED from it, and
 * `planWorkerSpawn` walks that budget one worker at a time. A refusal therefore
 * names a constraint the operator can see on a card two inches below the
 * dialog, and the panel and the dialog cannot come to disagree about capacity.
 *
 * PARTIAL SUCCESS IS THE NORMAL CASE, not the error case. Asking for five
 * workers when one lane is free is an ordinary thing to do, and `3 of 5
 * started · 2 refused` is the honest report of it. There is no rounding up to
 * "Done" and no silent truncation of the ask.
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
 * One system's lease budget as this executor sees it (doc 05's BudgetSnapshot).
 * `cap` is a property of the SYSTEM — UCPath invalidates the older session when
 * a second one authenticates, so its cap of 1 is not a tuning choice.
 */
export interface DemoBudgetSlot {
  system: string;
  inUse: number;
  cap: number;
}

/**
 * Why this executor is not progressing. This is the single most valuable thing
 * the Session Panel can say: a card that shows a healthy browser and a spinning
 * status while six items sit queued teaches the operator that the panel is
 * decorative. Naming the lease AND its holder turns "nothing is happening" into
 * "Separations has the one UCPath session, and it has had it for 18 minutes".
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
  /** items this executor may hold in flight at once */
  lanes?: { inUse: number; cap: number };
  /** the system leases it holds, and what each system allows */
  budgets?: DemoBudgetSlot[];
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
    lanes: { inUse: 1, cap: 1 },
    budgets: [
      { system: "ucpath", inUse: 1, cap: 1 },
      { system: "kuali", inUse: 1, cap: 2 },
      { system: "kronos", inUse: 1, cap: 2 },
    ],
    browsers: [
      { id: "b1", label: "kuali", health: "healthy", url: "kuali.ucsd.edu/space/HR" },
      { id: "b2", label: "ucpath", health: "healthy", url: "ucpath.universityofcalifornia.edu" },
      { id: "b3", label: "kronos", health: "refreshing", url: "kronos.ucsd.edu/timekeeping" },
    ],
  },
  {
    // The card the whole upgrade exists for. Alive, healthy, "running", six
    // items queued — and not moving, because Separations holds the one UCPath
    // session. Without the waiting note this card is a lie told with a spinner.
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
    lanes: { inUse: 1, cap: 2 },
    budgets: [
      { system: "ucpath", inUse: 0, cap: 1 },
      { system: "i9", inUse: 1, cap: 1 },
    ],
    waiting: { system: "ucpath", sinceSec: 264, heldByWorkflow: "Separations", heldByTrace: "se-140211-9f3a" },
    browsers: [{ id: "b4", label: "ucpath", health: "unknown", url: "ucpath…/PersonSearch" }],
  },
  {
    id: "s-ocr",
    workflow: "OCR",
    phase: "idle",
    subline: "idle — waiting for work",
    elapsedSec: 384,
    lanes: { inUse: 0, cap: 3 },
    budgets: [{ system: "i9", inUse: 0, cap: 1 }],
    browsers: [{ id: "b5", label: "i9", health: "healthy", url: "i9.ucsd.edu" }],
  },
  {
    id: "s-oath",
    workflow: "Oath Signature",
    phase: "authenticating",
    subline: "Authenticating 1/2",
    elapsedSec: 41,
    lanes: { inUse: 1, cap: 2 },
    budgets: [
      { system: "crm", inUse: 1, cap: 2 },
      { system: "ucpath", inUse: 0, cap: 1 },
    ],
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
// The lane budget — DERIVED from the cards, never authored beside them
// ---------------------------------------------------------------------------

/**
 * How many executors this machine may run at once, across every workflow.
 *
 * It is a property of the MACHINE — browsers, RAM, and one operator's Duo — so
 * it does not vary by workflow. Settings' `defaultWorkers` opens the per-run
 * stepper on a value; this is the ceiling that value cannot exceed.
 */
export const DEMO_EXECUTOR_CAP = 6;

/**
 * WHOSE budget a system's cap is, and it is the distinction the operator caught
 * the model getting wrong: *"uc path 1/1 does not make any sense. uc path 1/1
 * should mean that for each session there can only be 1 ucpath window. not for
 * each workflow."*
 *
 *   `session`  — ONE window for the whole app, shared by every workflow. UCPath
 *                is the case: authenticating a second PeopleSoft session
 *                invalidates the first, so the cap is a fact about the SYSTEM,
 *                the count is global, and "in use" means some workflow —
 *                possibly not the one you are looking at — is holding it.
 *   `workflow` — an ordinary pool this workflow draws from, where the cap is a
 *                tuning choice and two workflows can each hold their own.
 *
 * Both used to render as the same `1/1` chip in a dialog scoped to one
 * workflow, which made a session-wide singleton read as that workflow's own
 * allowance — so `Onboarding … ucpath 1/1` looked like Onboarding had used up
 * its UCPath budget when in fact Separations was holding the only window there
 * is. The accounting was already global (the fold sums every executor); what
 * was missing was any way for the surface to SAY so.
 */
export type LeaseScope = "session" | "workflow";

/**
 * A system's cap is a fact about the system, so the scope is declared here and
 * never inferred from a count. `cap === 1` is NOT the test — a pool of one is
 * still a pool.
 */
export const SYSTEM_LEASE_SCOPE: Record<string, LeaseScope> = {
  ucpath: "session",
};

export function leaseScopeOf(system: string): LeaseScope {
  return SYSTEM_LEASE_SCOPE[system] ?? "workflow";
}

export interface DemoSystemLease {
  system: string;
  inUse: number;
  cap: number;
  scope: LeaseScope;
  /** the workflows currently holding a lease on it — named, so a refusal can be */
  heldBy: string[];
}

export interface DemoLaneBudget {
  executorCap: number;
  /** live executors — a crashed one holds nothing */
  executorInUse: number;
  systems: DemoSystemLease[];
}

/**
 * The budget the whole app reads, folded up out of the SAME session array the
 * Session Panel renders.
 *
 * A crashed executor is not counted: it holds no lane and no lease, which is
 * exactly why its card says `Failed` rather than occupying capacity.
 */
export function laneBudgetOf(sessions: DemoSession[]): DemoLaneBudget {
  const systems = new Map<string, DemoSystemLease>();
  let executorInUse = 0;
  for (const s of sessions) {
    if (s.crashed) continue;
    executorInUse += 1;
    for (const b of s.budgets ?? []) {
      const slot = systems.get(b.system) ?? {
        system: b.system,
        inUse: 0,
        cap: b.cap,
        scope: leaseScopeOf(b.system),
        heldBy: [],
      };
      slot.inUse += b.inUse;
      // The cap is a property of the system, so every executor reports the same
      // one. Taking the smallest is the fail-safe read if a fixture disagrees.
      slot.cap = Math.min(slot.cap, b.cap);
      if (b.inUse > 0 && !slot.heldBy.includes(s.workflow)) slot.heldBy.push(s.workflow);
      systems.set(b.system, slot);
    }
  }
  return {
    executorCap: DEMO_EXECUTOR_CAP,
    executorInUse,
    systems: [...systems.values()].sort((a, b) => a.system.localeCompare(b.system)),
  };
}

export const DEMO_LANE_BUDGET: DemoLaneBudget = laneBudgetOf(DEMO_SESSIONS);

// ---------------------------------------------------------------------------
// Spawn — one command, a COUNT, and a per-worker answer
// ---------------------------------------------------------------------------

/** A quotable code per refusal. A refusal the operator cannot quote is one they cannot get help with. */
export type WorkerRefusalCode = "executor-pool-full" | "system-at-cap";

export interface WorkerSpawnOutcome {
  /** 1-based, so the vector reads "worker 3 of 5" without arithmetic */
  index: number;
  state: "started" | "refused";
  /** the executor id the worker would take — present only when it started */
  instance?: string;
  /** the system leases it claimed */
  claimed?: string[];
  code?: WorkerRefusalCode;
  /** names the real constraint, and who is holding it */
  reason?: string;
}

export interface WorkerSpawnResult {
  workflowId: DemoWorkflowId;
  workflowLabel: string;
  requested: number;
  started: number;
  refused: number;
  outcomes: WorkerSpawnOutcome[];
  /** the one-line headline, and it never rounds a partial up to success */
  headline: string;
}

/** The largest ask the stepper offers — the machine's own ceiling. */
export const MAX_WORKER_SPAWN = DEMO_EXECUTOR_CAP;

/**
 * Walk the budget one worker at a time and answer for each of them.
 *
 * This is a SIMULATION of the server's own loop, not a summary of it: worker 1
 * can take the last i9 lease and worker 2 is then refused for the reason worker
 * 1 created. That is why the answer is a vector — a single aggregate could not
 * say which of the five started, and "3 started" with no reason for the other
 * two is the shape the operator cannot act on.
 */
export function planWorkerSpawn(
  workflowId: DemoWorkflowId,
  count: number,
  budget: DemoLaneBudget = DEMO_LANE_BUDGET,
): WorkerSpawnResult {
  const workflow = DEMO_WORKFLOWS[workflowId];
  const needs: SystemKey[] = workflow.systems;
  // A local copy — planning must never mutate the budget the panel is showing.
  const free = new Map(budget.systems.map((s) => [s.system, s.cap - s.inUse]));
  const holders = new Map(budget.systems.map((s) => [s.system, s.heldBy]));
  let lanes = budget.executorCap - budget.executorInUse;
  let ordinal = budget.executorInUse;

  const outcomes: WorkerSpawnOutcome[] = [];
  for (let i = 1; i <= count; i += 1) {
    if (lanes <= 0) {
      outcomes.push({
        index: i,
        state: "refused",
        code: "executor-pool-full",
        reason: `This machine runs at most ${budget.executorCap} workers at once and ${budget.executorCap} are already up.`,
      });
      continue;
    }
    // A system the budget has never seen has no lease recorded, which means
    // nothing is holding it — that is an absence, not an unknown.
    const blocked = needs.find((s) => (free.get(s) ?? Number.POSITIVE_INFINITY) <= 0);
    if (blocked) {
      const held = holders.get(blocked) ?? [];
      const cap = budget.systems.find((s) => s.system === blocked)?.cap ?? 0;
      const holder =
        held.length > 0
          ? ` ${held.join(", ")} ${held.length === 1 ? "has" : "have"} ${cap === 1 ? "it" : "them"}.`
          : "";
      outcomes.push({
        index: i,
        state: "refused",
        code: "system-at-cap",
        // A SESSION singleton's refusal must not read as this workflow's budget
        // being spent — the whole app shares the one window, and the sentence
        // has to name that or the operator goes looking for their own runs to
        // cancel.
        reason:
          leaseScopeOf(blocked) === "session"
            ? `This session gets ${cap} ${blocked} window${cap === 1 ? "" : "s"}, shared by every workflow.${holder}`
            : `${blocked} allows ${cap} concurrent session${cap === 1 ? "" : "s"}.${holder}`,
      });
      continue;
    }
    lanes -= 1;
    ordinal += 1;
    const claimed: string[] = [];
    for (const s of needs) {
      const remaining = free.get(s);
      if (remaining !== undefined) {
        free.set(s, remaining - 1);
        holders.set(s, [...(holders.get(s) ?? []), workflow.label]);
      }
      claimed.push(s);
    }
    outcomes.push({
      index: i,
      state: "started",
      instance: `${workflow.code}-w${ordinal}`,
      claimed,
    });
  }

  const started = outcomes.filter((o) => o.state === "started").length;
  const refused = outcomes.length - started;
  const firstRefusal = outcomes.find((o) => o.state === "refused");
  return {
    workflowId,
    workflowLabel: workflow.label,
    requested: count,
    started,
    refused,
    outcomes,
    headline:
      refused === 0
        ? `${started} of ${count} started`
        : `${started} of ${count} started · ${refused} refused — ${firstRefusal?.reason ?? "no lane available"}`,
  };
}

/**
 * What the operator can be told BEFORE pressing, so the ask is informed rather
 * than a guess that gets corrected afterwards. Same walk, same numbers — the
 * preview cannot promise a count the command then refuses.
 */
export function workerSpawnCapacity(workflowId: DemoWorkflowId, budget: DemoLaneBudget = DEMO_LANE_BUDGET): {
  canStart: number;
  blocker?: string;
} {
  const probe = planWorkerSpawn(workflowId, MAX_WORKER_SPAWN, budget);
  const canStart = probe.started;
  return { canStart, blocker: probe.outcomes.find((o) => o.state === "refused")?.reason };
}

/** every workflow a worker can be started for, in the rail's own order */
export const WORKER_SPAWN_WORKFLOWS = DEMO_WORKFLOW_LIST;
