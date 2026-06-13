import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveRowArchetype, type RowArchetype } from "../domain/row-archetype.js";
import { log } from "../utils/log.js";
import { buildTrackerQueueSurfaces } from "./queue-surfaces.js";
import { DEFAULT_DIR, dateLocal, listWorkflows, readEntries } from "./jsonl-io.js";
import type { TrackerEntry } from "./jsonl.js";

/**
 * Row lifecycle debug trail. Replaces the older surface-only
 * `queue-surfaces-debug.ts`.
 *
 * The main tracker JSONL (`.tracker/<workflow>-<date>.jsonl`) is already an
 * append-only log: one line per `trackEvent`, carrying the row's data at that
 * moment. What it does NOT carry is (1) the dashboard's render *surface*
 * classification — card / member / flat / collapsed — which is derived at
 * render time and never persisted, and (2) cause attribution for operator
 * actions, so a cancel or a retry (which spawns a new runId under the same
 * item id) leave no labelled trail.
 *
 * This module **replays** that append-only JSONL start to finish — full
 * fidelity, no sampling blind spot — and for every row reconstructs its
 * lifecycle: each state change with the data accumulated so far, the surface
 * recomputed at that point (the classifier is a pure function of the row
 * set, so it can be evaluated as-of any moment), and the operator action
 * that caused it. Because the surface is recomputed against every other
 * row's state, a row that flips surface *after* it reached a terminal status
 * — the OCR-approval collapse fingerprint — is captured as a
 * `post-terminal-surface-change`.
 *
 * Two artifacts are written to the `.tracker/debug/` subdirectory on the
 * dashboard's 60s sweep, both fully regenerated from the immutable JSONL
 * source (idempotent — never streamed, never read programmatically, safe to
 * delete any time):
 *
 *  - `row-lifecycle-<date>.jsonl` — the chronological transition trail: one
 *    line per state change across all workflows, with from/to and cause.
 *  - `row-lifecycle-<date>.json`  — the per-row consolidated view: one
 *    `RowLifecycle` object per row holding its full ordered `history[]`.
 */

const TERMINAL_STATUSES = new Set<TrackerEntry["status"]>(["done", "failed", "skipped"]);

/** Operator action / milestone that produced a self-triggered transition. */
export type RowCause = "create" | "retry" | "reassign" | "cancel" | "discard" | "ocr-approval";

export type RowEventType = RowCause | "reach-terminal" | "post-terminal-surface-change";

/** One state of a row at a point in time. */
export interface RowSnapshot {
  ts: string;
  runId?: string;
  status: TrackerEntry["status"];
  step?: string;
  /** Resolved queue surface: `card:*` / `member:*` / `flat` / `discarded` / `hidden`. */
  surface: string;
  archetype: RowArchetype;
  /** `self` — the row's own tracker line; `sibling` — reclassified by another row's change. */
  trigger: "self" | "sibling";
  cause?: RowCause;
  memberCount: number;
  /** Data accumulated for this row up to and including this snapshot. */
  data: Record<string, string>;
  /** Keys whose value changed versus the previous snapshot. */
  dataChanged: string[];
}

/** A notable lifecycle milestone — operator action, terminal reach, late surface flip. */
export interface RowLifecycleEvent {
  ts: string;
  type: RowEventType;
  runId?: string;
  fromRunId?: string;
  toRunId?: string;
  fromSurface?: string;
  toSurface?: string;
}

/** Full lifecycle of a single queue row, keyed by tracker item id. */
export interface RowLifecycle {
  workflow: string;
  id: string;
  subject?: string;
  subjectKind?: string;
  archetype: RowArchetype;
  firstSeen: string;
  lastSeen: string;
  /** Every run attempt, in order — a retry appends a new runId under the same id. */
  runIds: string[];
  attemptCount: number;
  parentRunId?: string;
  isAnchor: boolean;
  memberIds: string[];
  input?: Record<string, unknown>;
  currentStatus: TrackerEntry["status"];
  currentStep?: string;
  currentSurface: string;
  terminal: boolean;
  /** First moment the row reached a terminal status. */
  terminalAt?: string;
  /** A `pending` state arrived after the row was already terminal (retry). */
  reopenedAfterTerminal: boolean;
  /** Surface flips that happened while the row was terminal — the collapse fingerprint. */
  postTerminalSurfaceChanges: number;
  endState: { status: TrackerEntry["status"]; step?: string; surface: string };
  history: RowSnapshot[];
  events: RowLifecycleEvent[];
}

/** One line of the chronological transition trail. */
export interface TransitionTrailLine {
  ts: string;
  workflow: string;
  id: string;
  runId?: string;
  /** Index of this transition within the row's own history. */
  seq: number;
  trigger: "self" | "sibling";
  cause: RowCause | null;
  from: { status: string; step: string | null; surface: string } | null;
  to: { status: string; step: string | null; surface: string };
  archetype: RowArchetype;
  memberCount: number;
  dataChanged: string[];
}

export interface RowSurfaceClassification {
  surface: string;
  memberIds: string[];
}

function runIdFor(entry: Pick<TrackerEntry, "id" | "runId">): string {
  return entry.runId ?? entry.id;
}

/** Stable JSON of a data record with sorted keys — used for change detection. */
function sortedDataJson(data: Record<string, string>): string {
  return JSON.stringify(data, Object.keys(data).sort());
}

function diffDataKeys(
  prev: Record<string, string>,
  cur: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(cur)]);
  return [...keys].filter((k) => prev[k] !== cur[k]).sort();
}

function stateSignature(parts: {
  status: string;
  step?: string;
  surface: string;
  archetype: string;
  memberCount: number;
  data: Record<string, string>;
}): string {
  return [
    parts.status,
    parts.step ?? "",
    parts.surface,
    parts.archetype,
    parts.memberCount,
    sortedDataJson(parts.data),
  ].join("|");
}

/**
 * Classify every live row into its queue surface. Feeds the same input shape
 * to `buildTrackerQueueSurfaces` the dashboard's server-side aggregation uses,
 * then maps each row id to a surface string:
 *  - `card:preview:<state>` / `card:batch`
 *  - `member:<kind>` — a sub-row rendered inside a card
 *  - `flat` — a top-level flat row
 *  - `discarded` — a discarded prep row, excluded from the queue
 *  - `hidden` — a live row rendered as no queue surface at all
 */
export function resolveRowSurfaces(
  liveEntries: TrackerEntry[],
): Map<string, RowSurfaceClassification> {
  const out = new Map<string, RowSurfaceClassification>();

  // Discarded prep rows are filtered out of buildTrackerQueueSurfaces
  // entirely; tag them directly so they don't fall through to "hidden".
  for (const entry of liveEntries) {
    if (
      entry.status === "failed" &&
      entry.step === "discarded" &&
      resolveRowArchetype(entry) === "preview"
    ) {
      out.set(entry.id, { surface: "discarded", memberIds: [] });
    }
  }

  const built = buildTrackerQueueSurfaces({
    entries: liveEntries,
    delegationSourceEntries: liveEntries,
  });

  const byRunId = new Map<string, TrackerEntry>();
  for (const entry of liveEntries) byRunId.set(runIdFor(entry), entry);

  for (const group of built.groupRows) {
    const memberIds = group.members.map((m) => m.id);
    if (group.kind === "preview") {
      out.set(group.parent.id, {
        surface: `card:preview:${group.approvalState}`,
        memberIds,
      });
    } else {
      const anchor = byRunId.get(group.parentRunId);
      if (anchor && !out.has(anchor.id)) {
        out.set(anchor.id, { surface: `card:${group.kind}`, memberIds });
      }
    }
  }
  for (const group of built.groupRows) {
    for (const member of group.members) {
      if (!out.has(member.id)) {
        out.set(member.id, { surface: `member:${group.kind}`, memberIds: [] });
      }
    }
  }
  for (const entry of built.flatEntries) {
    if (!out.has(entry.id)) out.set(entry.id, { surface: "flat", memberIds: [] });
  }
  for (const entry of liveEntries) {
    if (!out.has(entry.id)) out.set(entry.id, { surface: "hidden", memberIds: [] });
  }
  return out;
}

/**
 * Replay a workflow's append-only tracker entries chronologically and
 * reconstruct one {@link RowLifecycle} per row. Pure — no I/O, no shared
 * state — so the dashboard sweep and unit tests drive it the same way.
 */
export function buildRowLifecycles(
  workflow: string,
  rawEntries: TrackerEntry[],
): RowLifecycle[] {
  const entries = rawEntries
    .filter((e) => e.workflow === workflow)
    .slice()
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  const liveById = new Map<string, TrackerEntry>();
  const cycles = new Map<string, RowLifecycle>();
  const lastSnap = new Map<string, RowSnapshot>();
  const accumByRow = new Map<string, Record<string, string>>();

  for (const entry of entries) {
    liveById.set(entry.id, entry);
    const surfaces = resolveRowSurfaces([...liveById.values()]);

    for (const [id, live] of liveById) {
      const classification = surfaces.get(id) ?? { surface: "hidden", memberIds: [] };
      observeRow({
        workflow,
        id,
        live,
        classification,
        isSelf: id === entry.id,
        ts: entry.timestamp,
        cycles,
        lastSnap,
        accumByRow,
      });
    }
  }

  return [...cycles.values()];
}

interface ObserveArgs {
  workflow: string;
  id: string;
  live: TrackerEntry;
  classification: RowSurfaceClassification;
  isSelf: boolean;
  ts: string;
  cycles: Map<string, RowLifecycle>;
  lastSnap: Map<string, RowSnapshot>;
  accumByRow: Map<string, Record<string, string>>;
}

/** Record a snapshot for one row if its observable state changed. */
function observeRow(args: ObserveArgs): void {
  const { workflow, id, live, classification, isSelf, ts, cycles, lastSnap, accumByRow } = args;
  const { surface, memberIds } = classification;
  const archetype = resolveRowArchetype(live);

  // Accumulate data only on the row's own lines; later lines often carry a
  // partial `data`, so the running merge gives each snapshot the full picture.
  let accum = accumByRow.get(id) ?? {};
  if (isSelf && live.data) {
    accum = { ...accum, ...live.data };
    accumByRow.set(id, accum);
  }

  const signature = stateSignature({
    status: live.status,
    ...(live.step ? { step: live.step } : {}),
    surface,
    archetype,
    memberCount: memberIds.length,
    data: accum,
  });
  const prev = lastSnap.get(id);
  if (prev && stateSignature(prev) === signature) return;

  let cycle = cycles.get(id);
  if (!cycle) {
    cycle = {
      workflow,
      id,
      archetype,
      firstSeen: ts,
      lastSeen: ts,
      runIds: [],
      attemptCount: 0,
      isAnchor: false,
      memberIds: [],
      currentStatus: live.status,
      currentSurface: surface,
      terminal: false,
      reopenedAfterTerminal: false,
      postTerminalSurfaceChanges: 0,
      endState: { status: live.status, surface },
      history: [],
      events: [],
    };
    cycles.set(id, cycle);
  }

  const wasTerminal = cycle.terminal;
  const isTerminal = TERMINAL_STATUSES.has(live.status);
  const currentRunId = cycle.runIds[cycle.runIds.length - 1];

  let cause: RowCause | undefined;
  if (!prev) {
    cause = "create";
  } else if (isSelf) {
    if (live.status === "pending" && wasTerminal && live.runId && live.runId !== currentRunId) {
      cause = "retry";
    } else if (
      live.status === "pending" &&
      live.runId &&
      live.runId === currentRunId &&
      prev.status !== "pending"
    ) {
      // A `pending` re-emit under the SAME runId after the row already progressed
      // (running→pending un-claim, or a failed→pending dead-worker/teardown
      // requeue) is a REASSIGN — the item bounced to a surviving peer. Distinct
      // from a retry, which re-pends under a NEW runId (handled above). Without
      // this the reassign transition showed `cause=None` in the lifecycle debug
      // (VL-004). The `prev.status !== "pending"` guard excludes a benign
      // double-pending at run start (HTTP pre-emit + a daemon pending re-emit).
      cause = "reassign";
    } else if (live.status === "failed" && live.step === "cancelled") {
      cause = "cancel";
    } else if (live.status === "failed" && live.step === "discarded") {
      cause = "discard";
    } else if (
      live.status === "done" &&
      archetype === "batch" &&
      live.workflow === "ocr" &&
      // New approval contract (2026-05-25): the approve route writes
      // `done step=approved`; the kernel-path handler also returns,
      // letting the kernel emit a follow-up `done` with no step. Both
      // are "the operator approved" — attribute either as ocr-approval.
      (live.step === "approved" || live.step === undefined)
    ) {
      cause = "ocr-approval";
    }
  }

  const snapshot: RowSnapshot = {
    ts,
    ...(live.runId ? { runId: live.runId } : {}),
    status: live.status,
    ...(live.step ? { step: live.step } : {}),
    surface,
    archetype,
    trigger: isSelf ? "self" : "sibling",
    ...(cause ? { cause } : {}),
    memberCount: memberIds.length,
    data: { ...accum },
    dataChanged: prev ? diffDataKeys(prev.data, accum) : Object.keys(accum).sort(),
  };
  cycle.history.push(snapshot);
  lastSnap.set(id, snapshot);

  if (cause === "retry") {
    cycle.events.push({
      ts,
      type: "retry",
      ...(currentRunId ? { fromRunId: currentRunId } : {}),
      ...(live.runId ? { toRunId: live.runId } : {}),
    });
    cycle.reopenedAfterTerminal = true;
  } else if (cause) {
    cycle.events.push({ ts, type: cause, ...(live.runId ? { runId: live.runId } : {}) });
  }

  if (prev && prev.surface !== surface && wasTerminal && cause !== "retry" && cause !== "reassign") {
    cycle.postTerminalSurfaceChanges += 1;
    cycle.events.push({
      ts,
      type: "post-terminal-surface-change",
      fromSurface: prev.surface,
      toSurface: surface,
    });
  }

  if (isTerminal && !wasTerminal) {
    cycle.events.push({ ts, type: "reach-terminal", ...(live.runId ? { runId: live.runId } : {}) });
    if (!cycle.terminalAt) cycle.terminalAt = ts;
  }

  cycle.archetype = archetype;
  cycle.lastSeen = ts;
  cycle.terminal = isTerminal;
  cycle.currentStatus = live.status;
  if (live.step) cycle.currentStep = live.step;
  else delete cycle.currentStep;
  cycle.currentSurface = surface;
  cycle.memberIds = memberIds;
  cycle.isAnchor = archetype === "batch" || memberIds.length > 0;
  cycle.endState = { status: live.status, ...(live.step ? { step: live.step } : {}), surface };
  if (live.parentRunId) cycle.parentRunId = live.parentRunId;
  if (live.input) cycle.input = live.input;
  if (live.runId && currentRunId !== live.runId) cycle.runIds.push(live.runId);
  cycle.attemptCount = Math.max(cycle.runIds.length, 1);
  if (accum.__subject) cycle.subject = accum.__subject;
  if (accum.__subjectKind) cycle.subjectKind = accum.__subjectKind;
}

/** Flatten per-row lifecycles into one chronological transition trail. */
export function buildTransitionTrail(
  lifecyclesByWorkflow: Record<string, RowLifecycle[]>,
): TransitionTrailLine[] {
  const lines: TransitionTrailLine[] = [];
  for (const [workflow, lifecycles] of Object.entries(lifecyclesByWorkflow)) {
    for (const cycle of lifecycles) {
      cycle.history.forEach((snap, seq) => {
        const prev = seq > 0 ? cycle.history[seq - 1] : undefined;
        lines.push({
          ts: snap.ts,
          workflow,
          id: cycle.id,
          ...(snap.runId ? { runId: snap.runId } : {}),
          seq,
          trigger: snap.trigger,
          cause: snap.cause ?? null,
          from: prev
            ? { status: prev.status, step: prev.step ?? null, surface: prev.surface }
            : null,
          to: { status: snap.status, step: snap.step ?? null, surface: snap.surface },
          archetype: snap.archetype,
          memberCount: snap.memberCount,
          dataChanged: snap.dataChanged,
        });
      });
    }
  }
  lines.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return lines;
}

function writeRowLifecycleDebug(
  lifecyclesByWorkflow: Record<string, RowLifecycle[]>,
  dir: string,
): void {
  const debugDir = join(dir, "debug");
  mkdirSync(debugDir, { recursive: true });
  const date = dateLocal();

  writeFileSync(
    join(debugDir, `row-lifecycle-${date}.json`),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), date, workflows: lifecyclesByWorkflow },
      null,
      2,
    ),
  );

  const trail = buildTransitionTrail(lifecyclesByWorkflow);
  writeFileSync(
    join(debugDir, `row-lifecycle-${date}.jsonl`),
    trail.map((line) => JSON.stringify(line)).join("\n") + (trail.length ? "\n" : ""),
  );
}

/**
 * Replay + write one debug sweep across every workflow with tracker data for
 * the current day. Wired into the dashboard's 60s sweep; both output files
 * are fully regenerated from the immutable JSONL source. Failures are
 * swallowed so a debug-log glitch never stalls the dashboard.
 */
export function runRowLifecycleDebugSweep(dir: string = DEFAULT_DIR): void {
  try {
    const byWorkflow: Record<string, RowLifecycle[]> = {};
    for (const workflow of listWorkflows(dir)) {
      const lifecycles = buildRowLifecycles(workflow, readEntries(workflow, dir));
      if (lifecycles.length > 0) byWorkflow[workflow] = lifecycles;
    }
    if (Object.keys(byWorkflow).length > 0) {
      writeRowLifecycleDebug(byWorkflow, dir);
    }
  } catch (err) {
    log.warn(
      `row-lifecycle debug sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
