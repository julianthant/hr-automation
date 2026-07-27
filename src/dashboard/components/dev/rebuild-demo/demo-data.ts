/**
 * DEV-ONLY — the rebuild demo's world model (`?view=rebuild-demo`).
 *
 * One typed source of truth: every queue row — the 3 ratified row types
 * (run / group / member) across all 8 ratified statuses — carries its OWN
 * pipeline, log stream, data ledger, gate, receipt, and screenshot set, so the
 * demo log panel derives entirely per-row. Deterministic content only (stable
 * screenshots, no randomness).
 *
 * The rows here are the WIRE shape (`demo-wire.ts`), not a view model. A fixture
 * authors facts — instants, statuses, recorded durations — and `projectRow`
 * below plays the mock server: it derives the trace id, the clock label, the
 * elapsed timer, the run duration, the queue wait, the rollup and the whole
 * `actions[]` set. Nothing in this file hand-writes a value that a backend
 * would have computed.
 */

import { PROPOSED_STATUS, type ProposedStatus } from "./demo-status";
import {
  agoSeconds,
  at,
  DEMO_APP_VERSION,
  DEMO_OPERATOR,
  DEMO_WORKFLOWS,
  deriveActions,
  fmtClock,
  fmtClockSec,
  fmtElapsed,
  plusSeconds,
  secondsBetween,
  secondsSince,
  tabsFor,
  traceClock,
  type ActionDescriptorWire,
  type DemoTab,
  type DemoWorkflowId,
  type DemoWorkflowRef,
  type GateOptionSpec,
  type SystemKey,
} from "./demo-wire";

export type { SystemKey } from "./demo-wire";
export { fmtElapsed } from "./demo-wire";

/**
 * A system chip is NEUTRAL, in every system.
 *
 * Seven systems used to be painted with four categorical hues, on top of the
 * four status hues already in play — and the chip says the system's NAME, so
 * the colour was carrying nothing the label did not. One treatment, and the
 * live palette gets four hues back.
 */
export const SYSTEM_CHIP = "bg-[var(--ds-surface-2)] text-[color:var(--ds-fg-secondary)]";

export const SYSTEM_ACCENT: Record<SystemKey, string> = {
  kuali: SYSTEM_CHIP,
  ucpath: SYSTEM_CHIP,
  kronos: SYSTEM_CHIP,
  crm: SYSTEM_CHIP,
  servicenow: SYSTEM_CHIP,
  onbase: SYSTEM_CHIP,
  i9: SYSTEM_CHIP,
};

/**
 * The waterfall is the one place a per-system difference has to survive
 * WITHOUT a label — two touching segments must be tellable apart. So this is a
 * neutral ink RAMP, not a set of hues: adjacent systems get different weights,
 * which reads at 4px and costs the palette nothing.
 */
export const WATERFALL_ACCENT: Record<SystemKey, string> = {
  kuali: "bg-foreground/70",
  ucpath: "bg-foreground/45",
  kronos: "bg-foreground/28",
  crm: "bg-foreground/58",
  servicenow: "bg-foreground/36",
  onbase: "bg-foreground/64",
  i9: "bg-foreground/22",
};

export type StepState = "done" | "current" | "waiting" | "pending" | "failed" | "cancelled";

export interface DemoStep {
  label: string;
  state: StepState;
  system?: SystemKey;
  /** seconds — feeds the chip suffix + the waterfall */
  durationSec?: number;
  attempts?: number;
  keyLines?: string[];
  hasShot?: boolean;
}

export type LineKind = "nav" | "search" | "read" | "write" | "ok" | "error" | "warn" | "pause" | "event";

export interface DemoPill {
  dir: "read" | "write";
  label: string;
  value: string;
}

export interface DemoLine {
  ts: string;
  kind: LineKind;
  system?: SystemKey;
  text?: string;
  pills?: DemoPill[];
  attempt?: number;
  duration?: string;
  /** render the row's gate / failure card immediately after this line */
  card?: "gate" | "failure";
  /** step this line belongs to — drives the L2 dividers */
  step?: string;
}

export interface DemoDataPoint {
  step: string;
  dir: "read" | "write";
  field: string;
  value: string;
  system: SystemKey;
  ts: string;
  /** filled and verified, deliberately NOT submitted yet */
  staged?: boolean;
  /** submitted, but we could not read the outcome back — the Write-parked case */
  unconfirmed?: boolean;
}

export interface DemoGate {
  kind: "identity" | "parked" | "approval";
  title: string;
  /** the instant the gate opened — the ONLY input to the waiting age (D-Q7) */
  openedAt: string;
  candidates?: { heading: string; name: string; sub: string }[];
  staged?: { field: string; value: string; system: SystemKey; unconfirmed?: boolean }[];
  /**
   * The typed answers this gate accepts. They become banner-placement entries in
   * the row's `actions[]` — there is no second list of gate buttons anywhere.
   * A Write-parked gate's two options (`resolve-write-present` /
   * `resolve-write-absent`) are the ONLY two exits it has; there is no Resume,
   * because resuming an unknown write is how you terminate somebody twice.
   */
  options: GateOptionSpec[];
  note: string;
}

export interface DemoReceipt {
  tone: "success" | "warning" | "muted" | "destructive";
  headline: string;
  lines?: { label: string; value: string; verified?: boolean }[];
  /**
   * Per-member confirmation numbers, INLINE. A packet receipt is one artefact —
   * the operator reads every confirmation number here rather than opening N
   * member rows to collect them one link at a time.
   */
  members?: { name: string; value: string; verified?: boolean; failed?: boolean }[];
  note?: string;
}

export interface DemoShot {
  label: string;
  kind: "step" | "error" | "form";
}

export interface DemoFact {
  label?: string;
  value: string;
  arrowTo?: string;
  warn?: boolean;
}

/**
 * The one-line verdict. It carries NO button of its own — the thing to do about
 * the row is the `outcome`-placement entry in `actions[]`, so the queue subline
 * and the log panel's outcome bar offer exactly the same command.
 */
export interface DemoOutcome {
  tone: "warning" | "violet" | "info" | "success" | "destructive" | "muted";
  text: string;
}

/** One extracted person on an OCR packet — the unit of "review each person before approving". */
export interface DemoRecordField {
  label: string;
  value: string;
  /** where the value came from — drives the provenance chip */
  source: "paper" | "roster" | "ucpath";
  /** LLM confidence for a paper-read value (0–1); omitted for looked-up values */
  confidence?: number;
  editable?: boolean;
  warn?: string;
}

export interface DemoRecordCheck {
  label: string;
  state: "ok" | "warn" | "fail";
  value: string;
}

/**
 * A depth-2 delegated lookup — the OCR run delegating a person lookup for ONE
 * record. Deliberately reachable ONLY from the review row that owns the record:
 * surfacing it on the packet group would put a third level of run in a queue
 * that is already two deep.
 */
export interface DemoRecordLookup {
  trace: string;
  status: ProposedStatus;
  note: string;
}

export interface DemoRecord {
  id: string;
  name: string;
  eid?: string;
  /** page of the source PDF this person was read from */
  page: number;
  pageNote: string;
  /** ready = approvable · warn = approvable but flagged · blocked = cannot be approved */
  state: "ready" | "warn" | "blocked";
  fields: DemoRecordField[];
  checks: DemoRecordCheck[];
  /** why this record is blocked / what the warning means */
  note?: string;
  /** depth-2 delegated person lookup for this record — review row only */
  lookup?: DemoRecordLookup;
}

/**
 * How a child row is contained by its parent — the ONE field that decides where
 * a child lives and whether it is counted.
 *
 *  - `member`   created by the parent fanning out. Renders ONLY nested in the
 *               group. Counts toward the group.
 *  - `linked`   an independently meaningful sub-run the parent waits on. Keeps
 *               its OWN row in its OWN panel; the parent shows a chip, never a
 *               copy. NEVER counted as a member.
 *  - `rejected` the parent could not turn it into work. A Member Row,
 *               delete-only, counted separately, excluded from the rollup.
 */
export type Containment = "member" | "linked" | "rejected";

/** the parent's pointer at a set of `linked` children living in another panel */
export interface DemoLinkedGroup {
  ids: string[];
  /** "signers" / "contacts" / "person lookup" — what the linked runs are */
  noun: string;
  /** the Workflow Panel entry the chip jumps to */
  panel: string;
  /**
   * When the children were collapsed into ONE Group Row in their own panel
   * (S7), this is that group — the chip jumps to the group, not to a member
   * buried inside it.
   */
  groupId?: string;
}

/**
 * What the PARENT will do with a delegated run's answer. Without this line a
 * helper run seen from its own panel is context-free: you can read what it
 * looked up but not why anyone wanted it (delegation §5-S7).
 */
export interface DemoFeedsInto {
  /** `Oath_Packet_Summer.pdf · record 3 (Ben Brooks) EID` */
  label: string;
  /** the row that consumes the answer — the Data line links to it */
  targetRunId?: string;
}

/** one prior (or current) attempt of the same work — the RunSelector's items */
export interface DemoAttempt {
  n: number;
  /** the log-greppable tail; the trace id is DERIVED from this + startedAt */
  runId4: string;
  status: ProposedStatus;
  startedAt: string;
  endedAt?: string;
  summary: string;
}

/**
 * What changed between two attempts. `kind` is load-bearing: replayed data must
 * never be presented as newly observed (12 §2.4), so a reused checkpoint and a
 * fresh read are different rows with different words.
 */
export interface DemoRerunDiffEntry {
  kind: "input" | "checkpoint" | "correction" | "proof";
  label: string;
  prior: string;
  current: string;
  note?: string;
}

export interface DemoAttemptLineage {
  attempts: DemoAttempt[];
  diff: DemoRerunDiffEntry[];
}

/** a saved input preset merged into this run's typed values at enqueue */
export interface DemoPreset {
  name: string;
  /** where the preset came from — a saved mapping, a workflow constant set, … */
  source: string;
  merged: { field: string; value: string }[];
}

export interface DemoEvidenceWire {
  receiptId?: string;
  failureId?: string;
  /**
   * How much of this row's outcome was read back from the system of record.
   * `verified` = read back · `partial` = some of it · `unknown` = none.
   */
  confidence: "verified" | "partial" | "unknown";
}

/**
 * What a FIXTURE authors: facts only. Everything presentational — trace id,
 * clock label, elapsed, duration, rollup, actions — is derived in `projectRow`.
 */
export interface DemoRowSpec {
  id: string;
  rowType: "run" | "group" | "member";
  /** what the row is ABOUT — drives title/subtitle and the Run Row variant name */
  subjectKind?: "person" | "file" | "catalog";
  /** the registry entry; `workflow`, `wfLabel` and the trace prefix all come from it */
  workflowId: DemoWorkflowId;
  title: string;
  /** the operator's own name for this run — rides the row and the receipt */
  displayName?: string;
  eid?: string;
  /** first 4 chars of the runId — the trace id's log-greppable tail */
  runId4: string;
  /** the run's stable business key in the source system */
  itemId?: string;
  status: ProposedStatus;
  run: number;
  /** attempt number of this run; >1 means `retryOf` points at the prior one */
  attempt?: number;
  retryOf?: string;
  /** the server's CURRENT version of this row (CAS target) */
  version?: number;
  /**
   * The version the surface the operator is HOLDING was projected at. Lower
   * than `version` means the view is stale and every command on it will come
   * back `conflict` — the demo authors one row that way on purpose.
   */
  projectedVersion?: number;
  /** the rehearsal/real separator — a dry run writes nothing anywhere */
  dryRun?: boolean;
  priority?: "interactive" | "bulk";
  /** per-system prod/test resolution; a system left out resolved to prod */
  instance?: Partial<Record<SystemKey, "prod" | "test">>;
  /** the descriptor version this run executed under (defaults to the registry's current) */
  workflowVersion?: number;
  /** actor attribution — every row and every command records one */
  requestedBy?: string;
  /** accepted into the queue */
  enqueuedAt: string;
  /** a worker picked it up — absent while queued */
  startedAt?: string;
  /** reached a terminal state — absent while live */
  endedAt?: string;
  evidence?: DemoEvidenceWire;
  facts?: DemoFact[];
  warnings?: { count: number; first: string };
  /** cross-run retry lineage shown as a chip — `retryOf` is the id it replays */
  attemptHistory?: { n: number; prior: string };
  /** the full attempt list + what changed between the last two (RunSelector) */
  lineage?: DemoAttemptLineage;
  /** a saved preset merged into this run's inputs at enqueue */
  preset?: DemoPreset;
  /** what the parent will do with this delegated run's answer (S7) */
  feedsInto?: DemoFeedsInto;
  failShots?: number;
  receiptShield?: string;
  error?: string;
  liveText?: string;
  queueNote?: string;
  outcome: DemoOutcome;
  steps: DemoStep[];
  lines: DemoLine[];
  data: DemoDataPoint[];
  gate?: DemoGate;
  receipt: DemoReceipt;
  shots: DemoShot[];
  failCard?: { title: string; meta: string };
  /** group only */
  memberIds?: string[];
  /**
   * group only — the noun a COUNTED anchor titles itself with (`lookups`,
   * `separations`). The count is derived from the member set at projection, so
   * a title can never claim a number the group does not hold.
   */
  groupNoun?: string;
  ocrPhase?: string;
  /**
   * group only — how many people the OCR read out of the packet, BEFORE any
   * member row exists. A packet parked at review has zero members (nothing has
   * fanned out yet) but it still knows how many people are in the document.
   */
  extractedCount?: number;
  /**
   * group only — bulk approval offered on the ROW itself, so a clean packet
   * never has to be opened. Editing an extracted value is deliberately NOT
   * offered here: a value may only change with its scanned page on screen.
   */
  bulkApprove?: { approvable: number; total: number; blockedNote?: string; editNote: string };
  /** group only — the delegated OCR Review Row that owns this packet's records */
  reviewRunId?: string;
  /** review run only — the records the operator works through, and the group they belong to */
  records?: DemoRecord[];
  reviewOf?: string;
  /** how this row is contained by its parent — undefined on a root row */
  containment?: Containment;
  /** `linked` rows only — the row that is waiting on this one */
  linkedParentId?: string;
  /** the parent's pointer at its set of `linked` children in another panel */
  linkedGroup?: DemoLinkedGroup;
  /**
   * this row failed because a `linked` child failed — the child's error is
   * mirrored up so the operator never has to open the child to learn why.
   */
  mirroredFrom?: string;
  /** member only */
  parentId?: string;
  memberFact?: string;
  /** member only — the OCR record this member was fanned out from */
  recordId?: string;
  displayOnly?: boolean;
  checkedByDefault?: boolean;
}

/**
 * `QueueSurfaceWire` — one Queue Row as the backend will serve it. Every field
 * the spec left optional is resolved here, and every presentational value is
 * DERIVED. The React components consume only this.
 */
export interface DemoRow extends DemoRowSpec {
  /** identity — stamped once at enqueue, immutable */
  runId: string;
  itemId: string;
  workflow: DemoWorkflowRef;
  /** convenience mirror of `workflow.label` — the rail and the row chip read it */
  wfLabel: string;
  /** `<code>-<HHMMSS>-<runId4>`, frozen at enqueue */
  trace: string;
  /** the "EID if present, else the trace id" rule, resolved server-side */
  subtitle: string;
  parentRunId?: string;

  version: number;
  projectedVersion: number;
  attempt: number;
  dryRun: boolean;
  priority: "interactive" | "bulk";
  resolvedInstance: Partial<Record<SystemKey, "prod" | "test">>;
  workflowVersion: number;
  appVersion: string;
  requestedBy: string;
  evidence: DemoEvidenceWire;

  /** footer/banner/outcome/menu controls — the ONLY source of buttons */
  actions: ActionDescriptorWire[];
  /** capability-driven tabs for this row's panel kind */
  detailSurfaces: DemoTab[];

  /** derived clock label of the moment the row became real */
  time: string;
  /** derived from startedAt→endedAt; absent while the run is live */
  duration?: string;
  /** derived from startedAt→now; absent once the run ends. The shell adds its tick. */
  elapsedSec?: number;
  /** derived from enqueuedAt→startedAt — how long the row sat in the queue */
  queueWaitSec?: number;

  /** group only — ids, never nested trees (D10) */
  memberRunIds?: string[];
  memberRollup?: { status: ProposedStatus; count: number }[];
  /** excluded from the rollup — a rejected page is work that never existed (D3) */
  rejectedCount?: number;
  /**
   * group only — the first few member names, so a counted anchor with no title
   * of its own ("5 separations") still says WHO is in it. Derived, never typed.
   */
  memberPreview?: string;
}

// ---------------------------------------------------------------------------
// Rollup — ONE function, never recomputed per surface
// ---------------------------------------------------------------------------

/**
 * Ratified precedence. Read it as "what does this group most need from me":
 * a decision beats a breakage beats an unknown write beats work in flight.
 * Cancelled is last because a group nobody stopped is never cancelled.
 */
export const ROLLUP_PRECEDENCE: ProposedStatus[] = [
  "waiting",
  "failed",
  "parked",
  "running",
  "queued",
  "doneWarnings",
  "verifiedDone",
  "cancelled",
];

/**
 * `rejected` rows are excluded from the rollup — they never became work, so
 * they cannot count toward done. But they must not read as clean either, so an
 * otherwise-verified group with a rejected page settles at Done with warnings
 * until each rejection is deleted or acknowledged.
 */
export function rollupStatus(memberStatuses: ProposedStatus[], rejected: number, fallback: ProposedStatus): ProposedStatus {
  const winner = memberStatuses.length === 0 ? fallback : (ROLLUP_PRECEDENCE.find((s) => memberStatuses.includes(s)) ?? fallback);
  return rejected > 0 && winner === "verifiedDone" ? "doneWarnings" : winner;
}

// ---------------------------------------------------------------------------
// The projection — the mock server turning facts into a surface
// ---------------------------------------------------------------------------

/**
 * Everything a fixture did NOT write. Run once per row, at assembly, with the
 * whole raw corpus in hand so a group can roll its members up.
 *
 * This is the seam that makes the demo honest: if a component wants something
 * that cannot be computed here from served facts, the contract is missing a
 * field and we find out now instead of in production.
 *
 * Exported so the prior-day corpus (`demo-days.ts`) projects through the SAME
 * function: a row from Wednesday and a row from today are the same shape,
 * derived the same way, or date navigation would be showing a second model.
 */
export function projectRow(spec: DemoRowSpec, rawById: Map<string, DemoRowSpec>): DemoRow {
  const workflow = DEMO_WORKFLOWS[spec.workflowId];
  const version = spec.version ?? 1;
  const projectedVersion = spec.projectedVersion ?? version;
  const bornAt = spec.startedAt ?? spec.enqueuedAt;
  const trace = `${workflow.code}-${traceClock(bornAt)}-${spec.runId4}`;

  const memberSpecs = (spec.memberIds ?? []).map((id) => rawById.get(id)).filter((m): m is DemoRowSpec => Boolean(m));
  const realMembers = memberSpecs.filter((m) => m.containment !== "rejected");
  const rejectedCount = memberSpecs.length - realMembers.length;
  const status = spec.rowType === "group" ? rollupStatus(realMembers.map((m) => m.status), rejectedCount, spec.status) : spec.status;

  const rollupCounts = new Map<ProposedStatus, number>();
  for (const m of realMembers) rollupCounts.set(m.status, (rollupCounts.get(m.status) ?? 0) + 1);

  const resolvedInstance: Partial<Record<SystemKey, "prod" | "test">> = {};
  for (const system of workflow.systems) resolvedInstance[system] = spec.instance?.[system] ?? "prod";

  const stagedWrites = spec.data.filter((d) => d.dir === "write" && d.staged).length;

  // A counted anchor titles itself from the member set it actually holds —
  // "5 separations", "6 lookups · Oath_Packet_Summer.pdf". The number is never
  // typed into a fixture, so a title cannot drift from the group.
  const title = spec.groupNoun
    ? [`${realMembers.length} ${spec.groupNoun}`, spec.title].filter(Boolean).join(" · ")
    : spec.title;
  const previewNames = realMembers.slice(0, 3).map((m) => m.title);
  const memberPreview =
    spec.rowType === "group" && previewNames.length > 0
      ? previewNames.join(", ") + (realMembers.length > previewNames.length ? ` +${realMembers.length - previewNames.length} more` : "")
      : undefined;

  return {
    ...spec,
    title,
    memberPreview,
    runId: `run-${spec.id}`,
    itemId: spec.itemId ?? `${workflow.code}:${spec.id}`,
    workflow,
    wfLabel: workflow.label,
    trace,
    subtitle: spec.eid ?? trace,
    parentRunId: spec.parentId ?? spec.linkedParentId,

    version,
    projectedVersion,
    attempt: spec.attempt ?? 1,
    dryRun: spec.dryRun ?? false,
    priority: spec.priority ?? "interactive",
    resolvedInstance,
    workflowVersion: spec.workflowVersion ?? workflow.version,
    appVersion: DEMO_APP_VERSION,
    requestedBy: spec.requestedBy ?? DEMO_OPERATOR,
    evidence: spec.evidence ?? { confidence: "unknown" },

    actions: deriveActions(spec, {
      status,
      projectedVersion,
      memberCount: realMembers.length,
      rejectedCount,
      title: spec.displayName ?? title,
      workflow,
      stagedWrites,
    }),
    detailSurfaces: tabsFor(spec),

    time: fmtClock(bornAt),
    duration: spec.startedAt && spec.endedAt ? fmtElapsed(secondsBetween(spec.startedAt, spec.endedAt)) : undefined,
    elapsedSec: spec.startedAt && !spec.endedAt ? secondsSince(spec.startedAt) : undefined,
    queueWaitSec: spec.startedAt ? secondsBetween(spec.enqueuedAt, spec.startedAt) : undefined,

    memberRunIds: spec.memberIds,
    memberRollup: spec.rowType === "group" ? [...rollupCounts].map(([s, count]) => ({ status: s, count })) : undefined,
    rejectedCount: spec.rowType === "group" ? rejectedCount : undefined,
  };
}

// ===========================================================================
// Synthetic-name pool (shared by the row fixtures and the member factories)
// ===========================================================================

const FIRST = [
  "Ana", "Ben", "Carla", "Diego", "Emma", "Felix", "Grace", "Hugo", "Iris", "Jonah",
  "Kara", "Liam", "Mona", "Noel", "Opal", "Pablo", "Quinn", "Rita", "Sam", "Tara",
  "Uma", "Victor", "Wren", "Xena", "Yara",
];
const LAST = ["Alvarez", "Brooks", "Chen", "Diaz", "Egan", "Flores", "Garcia", "Hahn", "Ito", "Jones"];

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

// ===========================================================================
// Top-level rows — every ratified status appears at least once.
// ===========================================================================

const sepMaria: DemoRowSpec = {
  id: "sep-maria",
  rowType: "run",
  workflowId: "separations",
  title: "Maria Lopez-Garcia",
  runId4: "9f3a",
  itemId: "kuali:4-VMPHRW",
  status: "waiting",
  run: 4,
  version: 4,
  enqueuedAt: at("14:02:04"),
  startedAt: at("14:02:11"),
  evidence: { confidence: "unknown" },
  outcome: { tone: "warning", text: "Paused on identity approval — 18m in gate · nothing written yet" },
  steps: [
    { label: "Kuali extraction", state: "done", system: "kuali", durationSec: 41, hasShot: true, keyLines: ["last day worked = 07/15/2026", "termination type = Voluntary"] },
    { label: "Identity check", state: "done", system: "ucpath", durationSec: 12, keyLines: ["input: Maria Lopez", "match: M. Lopez-Garcia (10583942)"] },
    { label: "Job summary", state: "done", system: "ucpath", durationSec: 22, hasShot: true, keyLines: ["active job rec 0 · dept 000371"] },
    { label: "Kronos search", state: "done", system: "kronos", durationSec: 64, attempts: 2, keyLines: ["attempt 1 timeout · retried ok", "last punch 07/14 · 2 sick dates"] },
    { label: "UCPath transaction", state: "waiting", system: "ucpath" },
    { label: "Kuali finalization", state: "pending", system: "kuali" },
  ],
  lines: [
    { ts: "2:02:41", kind: "nav", system: "kuali", text: "Opened separation document 4-VMPHRW", step: "Kuali extraction" },
    { ts: "2:02:58", kind: "read", system: "kuali", pills: [{ dir: "read", label: "last day worked", value: "07/15/2026" }, { dir: "read", label: "separation date", value: "07/16/2026" }], step: "Kuali extraction" },
    { ts: "2:03:07", kind: "read", system: "kuali", pills: [{ dir: "read", label: "termination type", value: "Voluntary" }, { dir: "read", label: "dept", value: "000371" }], step: "Kuali extraction" },
    { ts: "2:03:22", kind: "ok", text: "Kuali extraction complete", duration: "41s", step: "Kuali extraction" },
    { ts: "2:03:25", kind: "search", system: "ucpath", text: "Person search: “Maria Lopez” — 1 active match", step: "Identity check" },
    { ts: "2:03:34", kind: "warn", text: "Resolved person differs from input record — pausing before any write", card: "gate", step: "Identity check" },
    { ts: "2:04:02", kind: "nav", system: "ucpath", text: "Job summary open — active job record 0", step: "Job summary" },
    { ts: "2:04:18", kind: "read", system: "ucpath", pills: [{ dir: "read", label: "position", value: "40128733" }], step: "Job summary" },
    { ts: "2:04:41", kind: "error", system: "kronos", text: "Employee search timed out after 30s", attempt: 1, card: "failure", step: "Kronos search" },
    { ts: "2:05:12", kind: "search", system: "kronos", text: "Employee search: 10583942", attempt: 2, step: "Kronos search" },
    { ts: "2:05:39", kind: "read", system: "kronos", pills: [{ dir: "read", label: "last punch", value: "07/14/2026" }, { dir: "read", label: "sick dates", value: "2" }], step: "Kronos search" },
    { ts: "2:05:45", kind: "ok", text: "Kronos search complete", duration: "1m 4s", step: "Kronos search" },
    { ts: "2:05:58", kind: "pause", text: "Paused — identity approval required before the termination write. Resolve in the Review tab.", step: "UCPath transaction" },
  ],
  data: [
    { step: "Kuali extraction", dir: "read", field: "Last day worked", value: "07/15/2026", system: "kuali", ts: "2:02:58" },
    { step: "Kuali extraction", dir: "read", field: "Separation date", value: "07/16/2026", system: "kuali", ts: "2:02:58" },
    { step: "Kuali extraction", dir: "read", field: "Termination type", value: "Voluntary", system: "kuali", ts: "2:03:07" },
    { step: "Kuali extraction", dir: "read", field: "Department", value: "000371", system: "kuali", ts: "2:03:07" },
    { step: "Job summary", dir: "read", field: "Position", value: "40128733", system: "ucpath", ts: "2:04:18" },
    { step: "Kronos search", dir: "read", field: "Last punch", value: "07/14/2026", system: "kronos", ts: "2:05:39" },
    { step: "Kronos search", dir: "read", field: "Sick dates in window", value: "2", system: "kronos", ts: "2:05:39" },
    { step: "UCPath transaction", dir: "write", field: "Separation date", value: "07/16/2026", system: "ucpath", ts: "—", staged: true },
    { step: "UCPath transaction", dir: "write", field: "Action", value: "Voluntary termination", system: "ucpath", ts: "—", staged: true },
  ],
  gate: {
    kind: "identity",
    title: "Waiting on you — identity approval",
    openedAt: at("14:03:34"),
    candidates: [
      { heading: "On the input record", name: "Maria Lopez", sub: "no EID · Kuali doc 4-VMPHRW" },
      { heading: "UCPath name match (proposed)", name: "M. Lopez-Garcia", sub: "10583942 · Dept 000371 · Blank Ast 3" },
    ],
    options: [
      { key: "use-eid", label: "Use 10583942", intent: "primary", command: "resolve-gate", resolution: "pick-eid:10583942" },
      { key: "manual-eid", label: "Enter EID…", intent: "neutral", command: "resolve-gate", resolution: "manual-eid" },
      {
        key: "dismiss",
        label: "Dismiss",
        intent: "neutral",
        command: "resolve-gate",
        resolution: "dismiss",
        confirm: {
          title: "End this separation with nothing written?",
          body: "Maria Lopez-Garcia stays employed in UCPath and the Kuali document stays open. The 2 staged writes are discarded. This does not undo the Kuali extraction — it just stops here.",
          confirmLabel: "Dismiss and end the run",
          tone: "destructive",
        },
      },
    ],
    note: "Resolving returns the run to Running at UCPath transaction; the staged writes in the Data tab go live. Dismiss ends the run with nothing written.",
  },
  receipt: {
    tone: "muted",
    headline: "Receipt — pending",
    note: "Issued once the UCPath write completes and read-back verification passes. This run has staged 2 writes and written nothing.",
  },
  shots: [
    { label: "Kuali doc 4-VMPHRW", kind: "step" },
    { label: "Identity check", kind: "step" },
    { label: "Job summary", kind: "step" },
    { label: "Kronos timeout", kind: "error" },
    { label: "Kronos search", kind: "step" },
    { label: "Paused at gate", kind: "step" },
  ],
  failCard: { title: "Step failed — retried automatically", meta: "Timeout in Kronos employee search (30s). Attempt 2 started 2:05:12." },
};

/**
 * The Write-parked specimen.
 *
 * Parked means ONE thing: a write was attempted and we cannot tell whether it
 * landed. It is NOT "filled but held before submitting" — that is an operator
 * decision, i.e. a gate, i.e. Waiting on you. Getting this wrong is dangerous in
 * both directions: a resumable hold dressed as parked invites a second submit
 * (duplicate termination), and a genuine unknown dressed as a hold invites
 * "Resume" on a write that already exists.
 *
 * So there is no Resume here. There are exactly two exits, and both are the
 * operator reporting what they SAW in UCPath: confirmed-present or
 * confirmed-absent.
 */
const sepRosa: DemoRowSpec = {
  id: "sep-rosa",
  rowType: "run",
  workflowId: "separations",
  title: "Rosa Delgado",
  eid: "10577201",
  runId4: "c2d7",
  itemId: "kuali:3-KQ2LMN",
  status: "parked",
  run: 3,
  version: 6,
  enqueuedAt: at("13:47:55"),
  startedAt: at("13:48:02"),
  // the write was attempted and never read back — that IS the unknown
  evidence: { confidence: "unknown" },
  outcome: {
    tone: "violet",
    text: "Write outcome unknown — submit sent, confirmation never came back. Do not re-run until you resolve it.",
  },
  steps: [
    { label: "Kuali extraction", state: "done", system: "kuali", durationSec: 38, hasShot: true },
    { label: "Identity check", state: "done", system: "ucpath", durationSec: 9 },
    { label: "Job summary", state: "done", system: "ucpath", durationSec: 20, hasShot: true },
    { label: "Kronos search", state: "done", system: "kronos", durationSec: 41 },
    {
      label: "UCPath transaction",
      state: "waiting",
      system: "ucpath",
      durationSec: 96,
      keyLines: ["submit posted 1:50:31", "session dropped before the confirmation page", "read-back could not run — outcome UNKNOWN"],
      hasShot: true,
    },
    { label: "Kuali finalization", state: "pending", system: "kuali" },
  ],
  lines: [
    { ts: "1:48:40", kind: "ok", text: "Extraction + identity + Kronos complete — no discrepancies", duration: "1m 48s", step: "Earlier steps" },
    { ts: "1:50:02", kind: "nav", system: "ucpath", text: "Smart HR termination template open", step: "UCPath transaction" },
    { ts: "1:50:29", kind: "write", system: "ucpath", pills: [{ dir: "write", label: "separation date", value: "07/18/2026" }, { dir: "write", label: "action", value: "Voluntary termination" }], step: "UCPath transaction" },
    { ts: "1:50:31", kind: "write", system: "ucpath", text: "Submit posted — waiting for the confirmation page", step: "UCPath transaction" },
    { ts: "1:52:07", kind: "error", system: "ucpath", text: "Session dropped before the confirmation page rendered — no transaction number was read", step: "UCPath transaction" },
    { ts: "1:52:09", kind: "warn", system: "ucpath", text: "Read-back attempted on a re-login — the person page did not load; the check itself failed, which is NOT the same as “no transaction found”", step: "UCPath transaction" },
    {
      ts: "1:52:10",
      kind: "pause",
      text: "Write parked — the transaction may or may not exist. Never auto-retried: a blind retry here is how you get two terminations.",
      card: "gate",
      step: "UCPath transaction",
    },
  ],
  data: [
    { step: "Kuali extraction", dir: "read", field: "Last day worked", value: "07/17/2026", system: "kuali", ts: "1:48:22" },
    { step: "Kuali extraction", dir: "read", field: "Separation date", value: "07/18/2026", system: "kuali", ts: "1:48:22" },
    { step: "Kronos search", dir: "read", field: "Last punch", value: "07/16/2026", system: "kronos", ts: "1:49:58" },
    { step: "UCPath transaction", dir: "write", field: "Separation date", value: "07/18/2026", system: "ucpath", ts: "1:50:29", unconfirmed: true },
    { step: "UCPath transaction", dir: "write", field: "Action", value: "Voluntary termination", system: "ucpath", ts: "1:50:29", unconfirmed: true },
    { step: "UCPath transaction", dir: "write", field: "Transaction number", value: "never read back", system: "ucpath", ts: "—", unconfirmed: true },
  ],
  gate: {
    kind: "parked",
    title: "Write parked — outcome unknown, resolve present or absent",
    openedAt: at("13:52:10"),
    staged: [
      { field: "Separation date", value: "07/18/2026", system: "ucpath", unconfirmed: true },
      { field: "Action", value: "Voluntary termination", system: "ucpath", unconfirmed: true },
    ],
    options: [
      {
        key: "confirmed-present",
        label: "Confirmed present",
        detail: "You found the termination in UCPath. The run closes as Verified done and records the transaction you read.",
        intent: "success",
        command: "resolve-write-present",
        confirm: {
          title: "Record the termination as PRESENT?",
          body: "This closes Rosa Delgado as Verified done against a write you read with your own eyes, and files a ledger entry attributed to you. If you are wrong, the queue will show a termination that does not exist.",
          confirmLabel: "I saw it — record present",
          tone: "neutral",
        },
      },
      {
        key: "confirmed-absent",
        label: "Confirmed absent",
        detail: "You found nothing in UCPath. The run closes as Failed and becomes safely retryable — the retry cannot duplicate.",
        intent: "destructive",
        command: "resolve-write-absent",
        confirm: {
          title: "Record the termination as ABSENT?",
          body: "This closes Rosa Delgado as Failed and UNLOCKS retry — the next run will submit a voluntary termination for 07/18/2026. If the first one did land, that is a duplicate termination.",
          confirmLabel: "I looked — nothing is there",
          tone: "destructive",
        },
      },
      { key: "open-shot", label: "Open the last screenshot", intent: "neutral", command: "resolve-gate", resolution: "view-evidence", icon: "external" },
      { key: "open-ucpath", label: "Open Rosa in UCPath", intent: "neutral", command: "resolve-gate", resolution: "view-system", icon: "external" },
    ],
    note: "Open Rosa Delgado in UCPath and look for a 07/18/2026 voluntary termination, then tell us which you saw. There is no Resume — resuming would submit a second time, and there is no auto-retry for the same reason.",
  },
  receipt: {
    tone: "muted",
    headline: "No receipt — the write could not be verified",
    lines: [
      { label: "Attempted", value: "Voluntary termination · 07/18/2026" },
      { label: "Submitted at", value: "1:50:31 PM" },
      { label: "Confirmation", value: "never read — session dropped" },
    ],
    note: "A receipt is a read-back, and the read-back never happened. Until you resolve present or absent this run has no verified outcome — the demo will not print one.",
  },
  shots: [
    { label: "Kuali doc", kind: "step" },
    { label: "Job summary", kind: "step" },
    { label: "Form at submit", kind: "form" },
    { label: "Dropped session", kind: "error" },
  ],
};

const plDaniel: DemoRowSpec = {
  id: "pl-daniel",
  rowType: "run",
  workflowId: "person-lookup",
  title: "Daniel Okafor",
  eid: "10488213",
  runId4: "72e1",
  status: "running",
  run: 12,
  version: 2,
  enqueuedAt: at("14:25:41"),
  startedAt: at("14:25:46"),
  evidence: { confidence: "unknown" },
  liveText: "Cross-verification — matching CRM record by start date",
  outcome: { tone: "info", text: "Running — cross-verification · matching CRM record by start date" },
  steps: [
    { label: "Searching", state: "done", system: "ucpath", durationSec: 6, keyLines: ["1 active match · 10488213"] },
    { label: "Cross-verification", state: "current", system: "crm" },
    { label: "Active status", state: "pending", system: "ucpath" },
    { label: "CRM dates", state: "pending", system: "crm" },
  ],
  lines: [
    { ts: "2:25:46", kind: "search", system: "ucpath", text: "Person search: “Daniel Okafor” — 1 active match", step: "Searching" },
    { ts: "2:25:50", kind: "read", system: "ucpath", pills: [{ dir: "read", label: "EID", value: "10488213" }, { dir: "read", label: "dept", value: "000512" }], step: "Searching" },
    { ts: "2:25:52", kind: "ok", text: "Searching complete", duration: "6s", step: "Searching" },
    { ts: "2:25:53", kind: "nav", system: "crm", text: "CRM onboarding record open", step: "Cross-verification" },
  ],
  data: [
    { step: "Searching", dir: "read", field: "EID", value: "10488213", system: "ucpath", ts: "2:25:50" },
    { step: "Searching", dir: "read", field: "Department", value: "000512", system: "ucpath", ts: "2:25:50" },
  ],
  receipt: { tone: "muted", headline: "Receipt — pending", note: "Person Lookup is read-only — its receipt records what was looked up and where, never a write." },
  shots: [{ label: "UCPath search", kind: "step" }],
};

/** canned live-sim lines the shell appends on a timer for the running row */
export const LIVE_SEQUENCE: DemoLine[] = [
  { ts: "2:26:00", kind: "read", system: "crm", pills: [{ dir: "read", label: "start date", value: "07/01/2026" }], step: "Cross-verification" },
  { ts: "2:26:03", kind: "ok", text: "CRM record matched by start date", step: "Cross-verification" },
  { ts: "2:26:05", kind: "nav", system: "ucpath", text: "Checking HR status — active flag", step: "Active status" },
  { ts: "2:26:08", kind: "read", system: "ucpath", pills: [{ dir: "read", label: "HR status", value: "Active" }], step: "Active status" },
];

const oathMemberIds = Array.from({ length: 12 }, (_, i) => `oath-m-${i}`);
const i9MemberIds = Array.from({ length: 50 }, (_, i) => `i9-m-${i}`);

const i9Batch: DemoRowSpec = {
  id: "i9-batch",
  rowType: "group",
  workflowId: "i9-check",
  title: "I9_Quarterly_Retention.pdf",
  runId4: "77aa",
  status: "running",
  run: 8,
  version: 51,
  priority: "bulk",
  enqueuedAt: at("13:39:52"),
  startedAt: at("13:40:01"),
  evidence: { confidence: "unknown" },
  ocrPhase: "UCPath search · roster re-match — 44/50 people processed",
  memberIds: i9MemberIds,
  outcome: { tone: "info", text: "Fan-out running — 44/50 people processed · 4 need attention" },
  steps: [
    { label: "OCR extraction", state: "done", system: "i9", durationSec: 190, keyLines: ["50 people found on 62 pages"] },
    { label: "Roster match", state: "done", system: "i9", durationSec: 44, keyLines: ["48 matched · 1 ambiguous · 1 no name"] },
    { label: "Member fan-out", state: "current", system: "ucpath" },
    { label: "Rollup", state: "pending" },
  ],
  lines: [
    { ts: "1:40:12", kind: "event", text: "OCR started — I9_Quarterly_Retention.pdf · 62 pages", step: "OCR extraction" },
    { ts: "1:43:22", kind: "ok", text: "OCR extraction complete — 50 people", duration: "3m 10s", step: "OCR extraction" },
    { ts: "1:44:06", kind: "warn", text: "Page 31 has no searchable name — rejected member row emitted (delete-only)", step: "Roster match" },
    { ts: "1:44:08", kind: "ok", text: "Roster re-match complete — 48 matched, 1 ambiguous", duration: "44s", step: "Roster match" },
    { ts: "1:44:10", kind: "event", text: "Fanned out 49 member tasks to the I-9 check daemon", step: "Member fan-out" },
    { ts: "2:01:44", kind: "warn", text: "2 members failed UCPath person search · 1 waiting on a name decision", step: "Member fan-out" },
  ],
  data: [
    { step: "OCR extraction", dir: "read", field: "People found", value: "50 (62 pages)", system: "i9", ts: "1:43:22" },
    { step: "Roster match", dir: "read", field: "Roster rows matched", value: "48 / 50", system: "i9", ts: "1:44:08" },
  ],
  receipt: { tone: "muted", headline: "Receipt — pending", note: "The group receipt rolls up when all 49 real members reach a terminal state: retention actions appended to the master tracker, per-member evidence linked." },
  shots: [
    { label: "Packet page 1", kind: "step" },
    { label: "Roster match report", kind: "step" },
  ],
};

const oathBatch: DemoRowSpec = {
  id: "oath-batch",
  rowType: "group",
  subjectKind: "file",
  workflowId: "oath-signature",
  title: "Oath_Packet_Spring.pdf",
  runId4: "c2f0",
  // authored as a fallback only — with members present the badge comes from the
  // shared rollup (one failed member outranks eleven verified ones)
  status: "failed",
  run: 4,
  version: 14,
  priority: "bulk",
  enqueuedAt: at("11:05:22"),
  startedAt: at("11:05:31"),
  endedAt: at("11:24:11"),
  evidence: { receiptId: "rcpt-os-c2f0", failureId: "fail-os-c2f0-m2", confidence: "partial" },
  warnings: { count: 1, first: "1 signer failed — signature field never rendered" },
  memberIds: oathMemberIds,
  reviewRunId: "ocr-spring",
  outcome: { tone: "destructive", text: "11/12 signed · Grace Egan failed — signature field never rendered" },
  steps: [
    { label: "OCR extraction", state: "done", system: "i9", durationSec: 130, keyLines: ["12 signers on 12 pages"] },
    { label: "Approval", state: "done", durationSec: 260, keyLines: ["approved 12/12 records 11:12 AM"] },
    { label: "Signer fan-out", state: "done", system: "ucpath", durationSec: 730 },
    { label: "Rollup", state: "done", durationSec: 2 },
  ],
  lines: [
    { ts: "11:05:31", kind: "event", text: "OCR started — Oath_Packet_Spring.pdf · 12 pages", step: "OCR extraction" },
    { ts: "11:07:41", kind: "ok", text: "12 records extracted · roster-matched", duration: "2m 10s", step: "OCR extraction" },
    { ts: "11:12:02", kind: "event", text: "Operator approved 12/12 — fanned out 12 signer tasks", step: "Approval" },
    { ts: "11:23:44", kind: "error", system: "ucpath", text: "Grace Egan — signature field never rendered after 3 attempts", step: "Signer fan-out" },
    { ts: "11:24:10", kind: "ok", text: "Rollup complete — 11 signed · 1 failed", step: "Rollup" },
  ],
  data: [
    { step: "OCR extraction", dir: "read", field: "Signers found", value: "12", system: "i9", ts: "11:07:41" },
    { step: "Signer fan-out", dir: "write", field: "Oaths signed", value: "11 of 12", system: "ucpath", ts: "11:23:58" },
  ],
  receipt: {
    tone: "warning",
    headline: "11 signed · 1 failed",
    lines: [
      { label: "Signed", value: "11 signers · 11:08–11:23 AM", verified: true },
      { label: "Failed", value: "Grace Egan — signature field never rendered" },
      { label: "Source packet", value: "Oath_Packet_Spring.pdf · 12 pages" },
    ],
    // Decision: per-member confirmation numbers are INLINE. The alternative —
    // one "open member" link per person — makes the operator collect twelve
    // numbers from twelve screens to file one packet.
    members: oathMemberIds.map((_, i) => {
      const name = `${FIRST[(i * 3) % 25]} ${LAST[(i * 7) % 10]}`;
      return i === 2
        ? { name, value: "no confirmation — signature field never rendered", failed: true }
        : { name, value: `OATH-2026-${pad(4400 + i * 7, 4)}`, verified: true };
    }),
    note: "Retry the failed signer from her member row — the other 11 are untouched.",
  },
  shots: [
    { label: "Packet page 1", kind: "step" },
    { label: "Approval snapshot", kind: "form" },
  ],
};

const onbJordan: DemoRowSpec = {
  id: "onb-jordan",
  rowType: "run",
  workflowId: "onboarding",
  title: "Jordan Whitfield",
  eid: "10633092",
  runId4: "4f9b",
  status: "verifiedDone",
  run: 2,
  version: 9,
  enqueuedAt: at("11:41:58"),
  startedAt: at("11:42:03"),
  endedAt: at("11:48:44"),
  evidence: { receiptId: "rcpt-on-4f9b", confidence: "verified" },
  receiptShield: "Receipt — UCPath read-back verified · TXN-0891245",
  facts: [
    { label: "wage", value: "$18.50/hr" },
    { label: "effective", value: "07/01" },
    { label: "dept", value: "000482" },
    { label: "txn", value: "TXN-0891245" },
  ],
  outcome: { tone: "success", text: "Hired — $18.50/hr effective 07/01 · TXN-0891245 read-back verified" },
  steps: [
    { label: "CRM extraction", state: "done", system: "crm", durationSec: 74, hasShot: true, keyLines: ["wage $18.50/hr · eff 07/01"] },
    { label: "PDF download", state: "done", system: "crm", durationSec: 31, keyLines: ["3 documents archived"] },
    { label: "Person search", state: "done", system: "ucpath", durationSec: 18 },
    { label: "I-9 creation", state: "done", system: "i9", durationSec: 92, hasShot: true },
    { label: "SmartHR transaction", state: "done", system: "ucpath", durationSec: 186, attempts: 1, hasShot: true, keyLines: ["TXN-0891245 · read-back ✓"] },
  ],
  lines: [
    { ts: "11:42:20", kind: "read", system: "crm", pills: [{ dir: "read", label: "wage", value: "$18.50/hr" }, { dir: "read", label: "effective", value: "07/01/2026" }], step: "CRM extraction" },
    { ts: "11:43:31", kind: "ok", text: "3 PDFs downloaded + archived", duration: "31s", step: "PDF download" },
    { ts: "11:44:02", kind: "search", system: "ucpath", text: "No existing person — new hire path", step: "Person search" },
    { ts: "11:45:40", kind: "write", system: "i9", pills: [{ dir: "write", label: "I-9 profile", value: "PRF-118203" }], step: "I-9 creation" },
    { ts: "11:48:12", kind: "write", system: "ucpath", pills: [{ dir: "write", label: "wage", value: "$18.50/hr" }, { dir: "write", label: "effective", value: "07/01/2026" }], step: "SmartHR transaction" },
    { ts: "11:48:44", kind: "ok", text: "Transaction submitted — TXN-0891245 · read-back verified", duration: "3m 6s", step: "SmartHR transaction" },
  ],
  data: [
    { step: "CRM extraction", dir: "read", field: "Wage", value: "$18.50/hr", system: "crm", ts: "11:42:20" },
    { step: "CRM extraction", dir: "read", field: "Effective date", value: "07/01/2026", system: "crm", ts: "11:42:20" },
    { step: "I-9 creation", dir: "write", field: "I-9 profile", value: "PRF-118203", system: "i9", ts: "11:45:40" },
    { step: "SmartHR transaction", dir: "write", field: "Wage", value: "$18.50/hr", system: "ucpath", ts: "11:48:12" },
    { step: "SmartHR transaction", dir: "write", field: "Effective date", value: "07/01/2026", system: "ucpath", ts: "11:48:12" },
  ],
  receipt: {
    tone: "success",
    headline: "Verified done · hire submitted",
    lines: [
      { label: "Wage", value: "$18.50/hr", verified: true },
      { label: "Effective date", value: "07/01/2026", verified: true },
      { label: "Transaction", value: "TXN-0891245", verified: true },
      { label: "I-9 profile", value: "PRF-118203", verified: true },
      { label: "Finished", value: "11:48 AM · 6m 41s active" },
      { label: "Run", value: "on-114203-4f9b · attempt 1" },
    ],
  },
  shots: [
    { label: "CRM record", kind: "step" },
    { label: "I-9 profile", kind: "step" },
    { label: "SmartHR form", kind: "form" },
    { label: "TXN confirmation", kind: "step" },
  ],
};

const kpMarcus: DemoRowSpec = {
  id: "kp-marcus",
  rowType: "run",
  workflowId: "kronos-pay-rule",
  title: "Marcus Bell",
  eid: "10312007",
  runId4: "d6a0",
  status: "verifiedDone",
  run: 6,
  version: 5,
  // the one row that ran against a TEST instance — the badge exists so a
  // rehearsal against a test system can never be mistaken for a real filing
  instance: { kronos: "test" },
  enqueuedAt: at("10:14:55"),
  startedAt: at("10:15:02"),
  endedAt: at("10:16:14"),
  evidence: { receiptId: "rcpt-kp-d6a0", confidence: "verified" },
  receiptShield: "Receipt — pay rule read back after save",
  facts: [
    { label: "pay rule", value: "SDCMP", arrowTo: "SDCMP-WS" },
    { label: "union", value: "CX" },
  ],
  outcome: { tone: "success", text: "Pay rule updated SDCMP → SDCMP-WS · read back after save" },
  steps: [
    { label: "CSV lookup", state: "done", durationSec: 2, keyLines: ["union CX · work-study election"] },
    { label: "Determine action", state: "done", durationSec: 1 },
    { label: "Update pay rule", state: "done", system: "kronos", durationSec: 69, hasShot: true, keyLines: ["SDCMP → SDCMP-WS · saved + read back"] },
  ],
  lines: [
    { ts: "10:15:03", kind: "read", pills: [{ dir: "read", label: "union", value: "CX" }, { dir: "read", label: "current rule", value: "SDCMP" }], step: "CSV lookup" },
    { ts: "10:15:41", kind: "write", system: "kronos", pills: [{ dir: "write", label: "pay rule", value: "SDCMP-WS" }], step: "Update pay rule" },
    { ts: "10:16:12", kind: "ok", text: "Saved — re-opened person, pay rule reads SDCMP-WS", duration: "1m 9s", step: "Update pay rule" },
  ],
  data: [
    { step: "CSV lookup", dir: "read", field: "Union code", value: "CX", system: "kronos", ts: "10:15:03" },
    { step: "CSV lookup", dir: "read", field: "Current pay rule", value: "SDCMP", system: "kronos", ts: "10:15:03" },
    { step: "Update pay rule", dir: "write", field: "Pay rule", value: "SDCMP-WS", system: "kronos", ts: "10:15:41" },
  ],
  receipt: {
    tone: "success",
    headline: "Verified done · pay rule updated",
    lines: [
      { label: "Pay rule", value: "SDCMP → SDCMP-WS", verified: true },
      { label: "Union", value: "CX" },
      { label: "Finished", value: "10:16 AM · 1m 12s" },
    ],
  },
  shots: [{ label: "Pay rule after save", kind: "step" }],
};

const obElena: DemoRowSpec = {
  id: "ob-elena",
  rowType: "run",
  workflowId: "onbase",
  title: "Elena Vasquez",
  eid: "10590114",
  runId4: "77b2",
  status: "doneWarnings",
  run: 3,
  version: 7,
  enqueuedAt: at("09:51:58"),
  startedAt: at("09:52:04"),
  endedAt: at("09:54:59"),
  evidence: { receiptId: "rcpt-ob-77b2", confidence: "partial" },
  warnings: { count: 1, first: "keyset autofill fell back — verify keywords" },
  facts: [
    { label: "doc", value: "I-9 Supporting" },
    { label: "page", value: "4" },
  ],
  outcome: { tone: "warning", text: "Imported with 1 warning — keyset autofill fell back, verify keywords" },
  steps: [
    { label: "Authenticate", state: "done", system: "onbase", durationSec: 21 },
    { label: "Prepare import", state: "done", system: "onbase", durationSec: 34 },
    { label: "Fill keywords", state: "done", system: "onbase", durationSec: 58, keyLines: ["keyset autofill FAILED — manual field fill fallback used"] },
    { label: "Import", state: "done", system: "onbase", durationSec: 40, hasShot: true },
  ],
  lines: [
    { ts: "9:53:11", kind: "warn", system: "onbase", text: "Keyset autofill did not populate — fell back to per-field fill (verify keywords)", step: "Fill keywords" },
    { ts: "9:54:20", kind: "write", system: "onbase", pills: [{ dir: "write", label: "doc type", value: "I-9 Supporting" }, { dir: "write", label: "EID", value: "10590114" }], step: "Fill keywords" },
    { ts: "9:54:55", kind: "ok", text: "Imported — document id assigned", duration: "40s", step: "Import" },
  ],
  data: [
    { step: "Fill keywords", dir: "write", field: "Document type", value: "I-9 Supporting", system: "onbase", ts: "9:54:20" },
    { step: "Fill keywords", dir: "write", field: "Employee ID", value: "10590114", system: "onbase", ts: "9:54:20" },
  ],
  receipt: {
    tone: "warning",
    headline: "Done with warnings · imported",
    lines: [
      { label: "Document", value: "I-9 Supporting · source page 4", verified: true },
      { label: "Keywords", value: "filled via FALLBACK — keyset autofill failed" },
      { label: "Finished", value: "9:54 AM · 2m 55s" },
    ],
    note: "Verify the keyword set on the imported document — the fallback path is field-by-field and worth a glance.",
  },
  shots: [
    { label: "Import confirmation", kind: "step" },
    { label: "Keyword panel", kind: "form" },
  ],
};

const cdSamuel: DemoRowSpec = {
  id: "cd-samuel",
  rowType: "run",
  workflowId: "crm-doc-download",
  title: "Samuel Ortiz",
  runId4: "5e19",
  status: "failed",
  run: 9,
  version: 4,
  attempt: 2,
  retryOf: "run-cd-samuel-a1",
  enqueuedAt: at("13:11:55"),
  startedAt: at("13:12:02"),
  endedAt: at("13:12:50"),
  evidence: { failureId: "fail-cd-5e19", confidence: "unknown" },
  attemptHistory: { n: 2, prior: "Attempt 1 failed 12:58 PM — timeout" },
  /**
   * The full lineage behind that chip. `diff` is what a rerun MUST say out
   * loud: which inputs changed, what was replayed from a checkpoint rather
   * than observed again, and which operator correction is in play. Replayed
   * data is never labelled as newly observed.
   */
  lineage: {
    attempts: [
      {
        n: 1,
        runId4: "0b8c",
        status: "failed",
        startedAt: at("12:58:02"),
        endedAt: at("12:58:41"),
        summary: "CRM search timed out after 30s — never reached the download step",
      },
      {
        n: 2,
        runId4: "5e19",
        status: "failed",
        startedAt: at("13:12:02"),
        endedAt: at("13:12:50"),
        summary: "CRM search returned 0 records for samuel.ortiz@ucsd.edu",
      },
    ],
    diff: [
      {
        kind: "input",
        label: "Email searched",
        prior: "samuel.ortiz@ucsd.edu",
        current: "samuel.ortiz@ucsd.edu",
        note: "unchanged — attempt 2 replayed the same input, which is why it failed differently rather than better",
      },
      {
        kind: "checkpoint",
        label: "CRM authentication",
        prior: "fresh login 12:58:04",
        current: "reused checkpoint · 14m old",
        note: "REPLAYED, not observed again — the session was still valid, so attempt 2 never re-authenticated",
      },
      {
        kind: "correction",
        label: "Roster email",
        prior: "not corrected",
        current: "not corrected",
        note: "the roster still carries the address that finds nobody — a third attempt with the same input will fail the same way",
      },
    ],
  },
  failShots: 3,
  error: "CRM search returned no record for samuel.ortiz@ucsd.edu — download step never reached",
  outcome: { tone: "destructive", text: "Failed — CRM search returned no record for samuel.ortiz@ucsd.edu" },
  steps: [
    { label: "CRM auth", state: "done", system: "crm", durationSec: 19 },
    { label: "Search record", state: "failed", system: "crm", durationSec: 29, attempts: 2, keyLines: ["no record for samuel.ortiz@ucsd.edu", "attempt 1 (12:58) timed out"] },
    { label: "Download", state: "pending", system: "crm" },
    { label: "Archive", state: "pending" },
  ],
  lines: [
    { ts: "1:12:21", kind: "search", system: "crm", text: "Searching onboarding records: samuel.ortiz@ucsd.edu", attempt: 2, step: "Search record" },
    { ts: "1:12:50", kind: "error", system: "crm", text: "0 results — no CRM record for this email", card: "failure", step: "Search record" },
  ],
  data: [],
  receipt: {
    tone: "destructive",
    headline: "No receipt — failed before any download",
    lines: [
      { label: "Failed at", value: "Search record · attempt 2" },
      { label: "Error", value: "no CRM record for samuel.ortiz@ucsd.edu" },
      { label: "Prior attempt", value: "12:58 PM — timeout" },
    ],
    note: "Nothing was written anywhere. Check the email on the input roster — this address may be mistyped.",
  },
  shots: [
    { label: "Search results (0)", kind: "error" },
    { label: "CRM auth", kind: "step" },
    { label: "Query as typed", kind: "error" },
  ],
  failCard: { title: "Run failed — no CRM record", meta: "Searched samuel.ortiz@ucsd.edu in onboarding records: 0 results. Likely a mistyped email on the roster." },
};

const wsPriya: DemoRowSpec = {
  id: "ws-priya",
  rowType: "run",
  workflowId: "work-study",
  title: "Priya Natarajan",
  eid: "10601188",
  runId4: "e8c3",
  status: "queued",
  run: 5,
  // THE STALE-VIEW SPECIMEN. The server is at version 5; the surface the
  // operator is holding was projected at 3, because two members were bumped
  // ahead of this row after it was pushed. Every command carries
  // expectedVersion 3 and comes back `conflict` until the row is refreshed.
  version: 5,
  projectedVersion: 3,
  // a rehearsal: this run will read UCPath and write nothing
  dryRun: true,
  enqueuedAt: at("14:24:01"),
  evidence: { confidence: "unknown" },
  queueNote: "in queue 3m · 2 ahead",
  outcome: { tone: "muted", text: "Queued — 2 items ahead · a worker picks this up next" },
  steps: [
    { label: "UCPath auth", state: "pending", system: "ucpath" },
    { label: "Transaction", state: "pending", system: "ucpath" },
  ],
  lines: [{ ts: "2:24:01", kind: "event", text: "Enqueued from the input panel — effective date 07/01/2026", step: "Queued" }],
  data: [
    { step: "Queued", dir: "read", field: "Effective date (input)", value: "07/01/2026", system: "ucpath", ts: "2:24:01" },
  ],
  receipt: { tone: "muted", headline: "Receipt — pending", note: "Nothing has run yet." },
  shots: [],
};

const ecTomas: DemoRowSpec = {
  id: "ec-tomas",
  rowType: "run",
  workflowId: "emergency-contact",
  title: "Tomás Rivera",
  eid: "10443321",
  runId4: "4a02",
  status: "cancelled",
  run: 1,
  version: 3,
  // ran under the PREVIOUS descriptor — the version chip is how an archived
  // run tells you it is not comparable with today's
  workflowVersion: 3,
  enqueuedAt: at("09:14:52"),
  startedAt: at("09:15:00"),
  endedAt: at("09:15:22"),
  evidence: { confidence: "unknown" },
  outcome: { tone: "warning", text: "Cancelled by you at Navigation — nothing written" },
  steps: [
    { label: "Navigation", state: "cancelled", system: "ucpath", durationSec: 22 },
    { label: "Fill form", state: "pending", system: "ucpath" },
    { label: "Save", state: "pending", system: "ucpath" },
  ],
  lines: [
    { ts: "9:15:08", kind: "nav", system: "ucpath", text: "Opening emergency contact page", step: "Navigation" },
    { ts: "9:15:30", kind: "warn", text: "Cancelled by operator — run stopped before the form was touched", step: "Navigation" },
  ],
  data: [],
  receipt: {
    tone: "muted",
    headline: "No receipt — cancelled before any write",
    lines: [{ label: "Cancelled at", value: "Navigation · 22s in" }],
    note: "Retry re-enqueues with the same input.",
  },
  shots: [],
};

// ===========================================================================
// Member factories
// ===========================================================================

const I9_SPECIAL: Record<number, ProposedStatus> = {
  4: "failed",
  11: "waiting",
  19: "doneWarnings",
  23: "failed",
  31: "running",
  38: "queued",
  39: "queued",
  40: "queued",
};
const I9_REJECTED_INDEX = 46;

function i9Member(i: number): DemoRowSpec {
  const name = i === I9_REJECTED_INDEX ? "Page 31" : `${FIRST[i % 25]} ${LAST[i % 10]}`;
  const eid = `105${pad(31000 + i * 137, 5)}`;
  const status: ProposedStatus = i === I9_REJECTED_INDEX ? "failed" : (I9_SPECIAL[i] ?? "verifiedDone");
  const startedAt = at(`13:${pad(45 + (i % 14), 2)}:${pad((i * 7) % 60, 2)}`);
  const ts = fmtClockSec(startedAt);
  const base: Omit<DemoRowSpec, "outcome" | "steps" | "lines" | "receipt"> = {
    id: `i9-m-${i}`,
    rowType: "member",
    parentId: "i9-batch",
    containment: i === I9_REJECTED_INDEX ? "rejected" : "member",
    workflowId: "i9-check",
    title: name,
    eid,
    runId4: `m${pad(i, 3)}`,
    status,
    run: 1,
    version: 2,
    priority: "bulk",
    // the whole fan-out was accepted at once; workers picked people up one at a
    // time, which is why the queue wait differs per member
    enqueuedAt: at("13:44:10"),
    startedAt,
    data: [],
    shots: [],
    checkedByDefault: status === "verifiedDone" && i < 12,
  };
  if (i === I9_REJECTED_INDEX) {
    return {
      ...base,
      // A rejected page never became a task, so it has no start and no end,
      // and there is no person on it — so no EID either, and the subtitle falls
      // back to the trace id by the same rule every other row uses.
      startedAt: undefined,
      eid: undefined,
      displayOnly: true,
      memberFact: "no searchable name",
      outcome: { tone: "muted", text: "Rejected page — no searchable name on the form. Display-only: no task exists, delete is the only action." },
      steps: [{ label: "OCR extraction", state: "failed", system: "i9", keyLines: ["page 31: no name field detected"] }],
      lines: [{ ts: "1:44:06", kind: "warn", system: "i9", text: "Page 31 — OCR found no searchable name; page cannot be checked", step: "OCR extraction" }],
      receipt: { tone: "muted", headline: "No receipt — rejected page", note: "Not a person row. Delete it once you've confirmed the page is a cover sheet / non-form scan." },
    };
  }
  const doneSteps: DemoStep[] = [
    { label: "Person match", state: "done", system: "ucpath", durationSec: 8 + (i % 5) },
    { label: "Person lookup", state: "done", system: "ucpath", durationSec: 14 + (i % 7), hasShot: true },
    { label: "Roster match", state: "done", system: "i9", durationSec: 3 },
  ];
  switch (status) {
    case "failed":
      return {
        ...base,
        memberFact: "no UCPath match",
        endedAt: plusSeconds(startedAt, 41),
        evidence: { failureId: `fail-ic-m${pad(i, 3)}`, confidence: "unknown" },
        error: `UCPath person search found no match for “${name}” or EID ${eid}`,
        outcome: { tone: "destructive", text: `No UCPath match for “${name}” — roster row left unmatched` },
        steps: [
          { label: "Person match", state: "failed", system: "ucpath", durationSec: 41, keyLines: [`“${name}” → 0 rows`, `EID ${eid} → 0 rows`] },
          { label: "Person lookup", state: "pending", system: "ucpath" },
          { label: "Roster match", state: "pending", system: "i9" },
        ],
        lines: [
          { ts, kind: "search", system: "ucpath", text: `Person search: “${name}” → no rows · retried by EID → no rows`, card: "failure", step: "Person match" },
        ],
        failCard: { title: "Person search found no match", meta: `Searched “${name}” + EID ${eid} in UCPath — 0 results either way.` },
        receipt: { tone: "destructive", headline: "No receipt — person not found", lines: [{ label: "Failed at", value: "Person match" }, { label: "Roster row", value: `${i + 1} — left unmatched` }], note: "Check the roster spelling; retry replays this one person only." },
        shots: [{ label: "Search results (0)", kind: "error" }],
      };
    case "waiting":
      return {
        ...base,
        memberFact: "2 name candidates",
        outcome: { tone: "warning", text: "Two active UCPath people match this name — pick one" },
        steps: [
          { label: "Person match", state: "waiting", system: "ucpath", keyLines: ["2 active candidates share this name"] },
          { label: "Person lookup", state: "pending", system: "ucpath" },
          { label: "Roster match", state: "pending", system: "i9" },
        ],
        lines: [
          { ts, kind: "warn", system: "ucpath", text: "2 active people named on this form — pausing for a decision", card: "gate", step: "Person match" },
        ],
        gate: {
          kind: "identity",
          title: "Waiting on you — which person is on the form?",
          openedAt: plusSeconds(startedAt, 12),
          candidates: [
            { heading: "Candidate A", name: `${name}`, sub: `10531548 · Dept 000371 · hired 03/12/2024` },
            { heading: "Candidate B", name: `${name} (2nd match)`, sub: `10577940 · Dept 000512 · hired 09/02/2019` },
          ],
          options: [
            { key: "use-a", label: "Use 10531548", intent: "primary", command: "resolve-gate", resolution: "pick-eid:10531548" },
            { key: "use-b", label: "Use 10577940", intent: "neutral", command: "resolve-gate", resolution: "pick-eid:10577940" },
            {
              key: "skip",
              label: "Skip person",
              intent: "neutral",
              command: "resolve-gate",
              resolution: "dismiss",
              confirm: {
                title: `Skip ${name}?`,
                body: "This person is left unchecked and the roster row stays unmatched. The packet still completes; nothing is written for them.",
                confirmLabel: "Skip this person",
                tone: "destructive",
              },
            },
          ],
          note: "The I-9 hire date on the form (03/12/2024) matches candidate A within tolerance — shown first.",
        },
        receipt: { tone: "muted", headline: "Receipt — pending", note: "Blocked on the identity decision; nothing recorded yet." },
        shots: [{ label: "Both candidates", kind: "step" }],
      };
    case "doneWarnings":
      return {
        ...base,
        memberFact: "S2 missing — flag",
        endedAt: plusSeconds(startedAt, 34 + (i % 5) * 7),
        evidence: { receiptId: `rcpt-ic-m${pad(i, 3)}`, confidence: "partial" },
        warnings: { count: 1, first: "Section 2 page not found in packet" },
        outcome: { tone: "warning", text: "Checked with 1 warning — Section 2 page missing from packet" },
        steps: doneSteps,
        lines: [
          { ts: ts, kind: "ok", system: "ucpath", text: "Person found · active", step: "Person lookup" },
          { ts: ts, kind: "warn", system: "i9", text: "Section 1 on page 22 — no Section 2 page found for this person", step: "Roster match" },
        ],
        receipt: {
          tone: "warning",
          headline: "Done with warnings · retention flagged",
          lines: [
            { label: "UCPath", value: "found · active", verified: true },
            { label: "Section 1", value: "page 22", verified: true },
            { label: "Section 2", value: "MISSING — flagged on the retention tracker" },
          ],
        },
        shots: [{ label: "Section 1 p22", kind: "step" }],
      };
    case "running":
      return {
        ...base,
        startedAt: agoSeconds(34),
        memberFact: "person-lookup…",
        liveText: "Person lookup — cross-verifying hire date",
        outcome: { tone: "info", text: "Running — person lookup, cross-verifying hire date" },
        steps: [
          { label: "Person match", state: "done", system: "ucpath", durationSec: 9 },
          { label: "Person lookup", state: "current", system: "ucpath" },
          { label: "Roster match", state: "pending", system: "i9" },
        ],
        lines: [
          { ts: fmtClockSec(agoSeconds(25)), kind: "ok", system: "ucpath", text: "Person matched — 1 active row", step: "Person match" },
          { ts: fmtClockSec(agoSeconds(18)), kind: "nav", system: "ucpath", text: "Opening person profile for hire-date check", step: "Person lookup" },
        ],
        receipt: { tone: "muted", headline: "Receipt — pending", note: "Still running." },
        shots: [],
      };
    case "queued":
      return {
        ...base,
        startedAt: undefined,
        memberFact: "—",
        queueNote: `in queue · position ${i - 37}`,
        outcome: { tone: "muted", text: "Queued behind the running member" },
        steps: [
          { label: "Person match", state: "pending", system: "ucpath" },
          { label: "Person lookup", state: "pending", system: "ucpath" },
          { label: "Roster match", state: "pending", system: "i9" },
        ],
        lines: [{ ts: "1:44:10", kind: "event", text: "Fanned out — waiting for the I-9 check daemon", step: "Queued" }],
        receipt: { tone: "muted", headline: "Receipt — pending", note: "Nothing has run yet." },
        shots: [],
      };
    default:
      return {
        ...base,
        memberFact: "S1 + S2 · retain 3y",
        endedAt: plusSeconds(startedAt, 34 + (i % 5) * 7),
        evidence: { receiptId: `rcpt-ic-m${pad(i, 3)}`, confidence: "verified" },
        facts: [
          { label: "S1", value: `p${(i % 30) + 2}` },
          { label: "S2", value: `p${(i % 20) + 1}` },
          { label: "retain", value: "3y" },
        ],
        outcome: { tone: "success", text: "Checked — both sections present, retention 3y appended to master tracker" },
        steps: doneSteps,
        lines: [
          { ts, kind: "ok", system: "ucpath", text: "Person found · separated 06/30/2026", step: "Person lookup" },
          { ts, kind: "write", system: "i9", pills: [{ dir: "write", label: "retention", value: "3y from separation" }], step: "Roster match" },
        ],
        receipt: {
          tone: "success",
          headline: "Verified done · retention recorded",
          lines: [
            { label: "UCPath", value: "found · separated 06/30/2026", verified: true },
            { label: "Sections", value: `S1 p${(i % 30) + 2} · S2 p${(i % 20) + 1}`, verified: true },
            { label: "Retention", value: "3 years from separation", verified: true },
          ],
        },
        shots: [{ label: "Person profile", kind: "step" }],
      };
  }
}

function oathMember(i: number): DemoRowSpec {
  const name = `${FIRST[(i * 3) % 25]} ${LAST[(i * 7) % 10]}`;
  const eid = `105${pad(31000 + i * 91, 5)}`;
  const failed = i === 2;
  const startedAt = at(`11:${pad(8 + i, 2)}:04`);
  const signTime = fmtClock(startedAt);
  return {
    id: `oath-m-${i}`,
    rowType: "member",
    parentId: "oath-batch",
    containment: "member",
    recordId: `spring-rec-${i}`,
    workflowId: "oath-signature",
    title: name,
    eid,
    runId4: `m${pad(i, 3)}`,
    status: failed ? "failed" : "verifiedDone",
    run: 1,
    version: 2,
    priority: "bulk",
    enqueuedAt: at("11:12:02"),
    startedAt,
    endedAt: plusSeconds(startedAt, failed ? 62 : 35 + (i % 6)),
    evidence: failed
      ? { failureId: `fail-os-m${pad(i, 3)}`, confidence: "unknown" }
      : { receiptId: `rcpt-os-m${pad(i, 3)}`, confidence: "verified" },
    memberFact: failed ? "signature field never rendered" : `signed ${signTime}`,
    error: failed ? "Signature field never rendered after 3 attempts" : undefined,
    outcome: failed
      ? { tone: "destructive", text: "Signature field never rendered after 3 attempts" }
      : { tone: "success", text: `Oath signed ${signTime} — CRM verified` },
    steps: failed
      ? [
          { label: "CRM verify", state: "done", system: "crm", durationSec: 12 },
          { label: "UCPath auth", state: "done", system: "ucpath", durationSec: 8 },
          { label: "Sign oath", state: "failed", system: "ucpath", durationSec: 42, attempts: 3, keyLines: ["signature canvas never mounted"] },
        ]
      : [
          { label: "CRM verify", state: "done", system: "crm", durationSec: 10 + (i % 4) },
          { label: "UCPath auth", state: "done", system: "ucpath", durationSec: 7 },
          { label: "Sign oath", state: "done", system: "ucpath", durationSec: 18 + (i % 5), hasShot: true },
        ],
    lines: failed
      ? [{ ts: fmtClockSec(plusSeconds(startedAt, 62)), kind: "error", system: "ucpath", text: "Signature field never rendered (3 attempts, fresh page each)", card: "failure", step: "Sign oath" }]
      : [
          { ts: fmtClockSec(plusSeconds(startedAt, 17)), kind: "ok", system: "crm", text: "CRM onboarding record verified", step: "CRM verify" },
          { ts: fmtClockSec(plusSeconds(startedAt, 36)), kind: "write", system: "ucpath", pills: [{ dir: "write", label: "oath signed", value: signTime }], step: "Sign oath" },
        ],
    data: failed
      ? []
      : [{ step: "Sign oath", dir: "write", field: "Oath signature", value: signTime, system: "ucpath", ts: fmtClockSec(plusSeconds(startedAt, 36)) }],
    failCard: failed ? { title: "Signature field never rendered", meta: "3 attempts on fresh pages — the oath form's canvas never mounted for this person." } : undefined,
    receipt: failed
      ? { tone: "destructive", headline: "No receipt — oath not signed", note: "Retry replays just this signer; the PDF and other signers are untouched." }
      : {
          tone: "success",
          headline: "Verified done · oath signed",
          lines: [
            { label: "Signed", value: signTime, verified: true },
            { label: "CRM check", value: "onboarding record verified", verified: true },
          ],
        },
    shots: failed ? [{ label: "Blank canvas", kind: "error" }] : [{ label: "Signed oath", kind: "step" }],
  };
}

// ===========================================================================
// Packet at approval — the "review each person before approving" flow.
//
// A Packet Group Row (oath-summer) that has NO member rows yet: members are
// created by the parent fanning out, and nothing has fanned out because nothing
// has been approved. What the packet knows is how many people the OCR read out
// of it — so it shows an extracted count, not an invented member list.
//
// Beside it, the delegated OCR Review Row (ocr-summer) OWNS the per-person
// records. It is `linked`, not `member`: it keeps its own row in the OCR panel
// and the two point at each other instead of the same run appearing twice.
// ===========================================================================

const SUMMER_PEOPLE: { name: string; eid: string; page: number; state: DemoRecord["state"] }[] = [
  { name: "Ana Alvarez", eid: "10510221", page: 2, state: "ready" },
  { name: "Ben Brooks", eid: "10538744", page: 3, state: "warn" },
  { name: "Carla Chen", eid: "10552018", page: 4, state: "ready" },
  { name: "Diego Diaz", eid: "10499310", page: 5, state: "blocked" },
  { name: "Emma Egan", eid: "10571663", page: 6, state: "warn" },
  { name: "Felix Flores", eid: "10583127", page: 7, state: "ready" },
];

function summerRecord(i: number): DemoRecord {
  const p = SUMMER_PEOPLE[i];
  const base: DemoRecord = {
    id: `rec-${i}`,
    name: p.name,
    eid: p.eid,
    page: p.page,
    pageNote: `page ${p.page} of 8 · oath form`,
    state: p.state,
    fields: [
      { label: "Printed name", value: p.name, source: "paper", confidence: 0.97, editable: true },
      { label: "Employee ID", value: p.eid, source: "paper", confidence: 0.93, editable: true },
      { label: "Signature date", value: "07/21/2026", source: "paper", confidence: 0.95, editable: true },
      { label: "Department", value: "000371 · Student Health", source: "ucpath" },
      { label: "Payroll title", value: "Blank Assistant 3", source: "ucpath" },
    ],
    checks: [
      { label: "Roster match", state: "ok", value: "matched row 14" },
      { label: "UCPath person", state: "ok", value: `1 active match · ${p.eid}` },
      { label: "Employment status", state: "ok", value: "Active" },
      { label: "Employee signed", state: "ok", value: "yes — on paper" },
      { label: "Officer signed", state: "ok", value: "yes — on paper" },
    ],
    // Depth 2. This lookup ran UNDER the OCR run, for this record only. It is
    // shown here and nowhere else — the packet group never lists it.
    lookup: {
      trace: `pl-1423${pad(20 + i * 3, 2)}-${pad(i, 2)}a1`,
      status: p.state === "blocked" ? "doneWarnings" : "verifiedDone",
      note:
        p.state === "blocked"
          ? "found the person, but UCPath reports them separated"
          : `resolved ${p.eid} from the printed name`,
    },
  };
  if (p.state === "warn" && i === 1) {
    return {
      ...base,
      fields: base.fields.map((f) =>
        f.label === "Employee ID" ? { ...f, confidence: 0.44, warn: "low confidence — handwriting unclear, confirm before approving" } : f,
      ),
      checks: base.checks.map((c) => (c.label === "UCPath person" ? { ...c, state: "warn", value: "matched by name — EID read is low confidence" } : c)),
      note: "The EID on paper was read at 0.44 confidence. UCPath found this person by NAME, so the write is safe — but confirm the digits against the form image before approving.",
    };
  }
  if (p.state === "warn" && i === 4) {
    return {
      ...base,
      checks: base.checks.map((c) => (c.label === "Employee signed" ? { ...c, state: "warn", value: "NO — signature box is blank" } : c)),
      note: "The employee signature box on page 6 is blank. Approving files an unsigned oath — send it back for signature unless you have a countersigned copy.",
    };
  }
  if (p.state === "blocked") {
    return {
      ...base,
      fields: base.fields.map((f) =>
        f.label === "Department" ? { ...f, value: "000512 · Facilities (separated)" } : f,
      ),
      checks: base.checks.map((c) =>
        c.label === "Employment status" ? { ...c, state: "fail", value: "Inactive — separated 06/30/2026" } : c,
      ),
      note: "UCPath shows this person separated on 06/30/2026. An inactive employee cannot be signed — this record is blocked and is excluded from Approve.",
    };
  }
  return base;
}

const SUMMER_RECORDS: DemoRecord[] = SUMMER_PEOPLE.map((_, i) => summerRecord(i));

/**
 * The delegated lookups, one per record. Declared here (not beside their
 * fixtures) because `ocr-summer` points at them — a module const referenced
 * before its declaration is a TDZ crash at page load, which typecheck cannot
 * see.
 */
const PL_SUMMER_IDS = SUMMER_PEOPLE.map((_, i) => `pls-m-${i}`);

const oathSummer: DemoRowSpec = {
  id: "oath-summer",
  rowType: "group",
  subjectKind: "file",
  workflowId: "oath-signature",
  title: "Oath_Packet_Summer.pdf",
  runId4: "b410",
  status: "waiting",
  run: 5,
  version: 8,
  priority: "bulk",
  enqueuedAt: at("14:20:05"),
  startedAt: at("14:20:12"),
  evidence: { confidence: "unknown" },
  ocrPhase: "6 people extracted — waiting on your review",
  // No members yet, on purpose: member rows are created by the fan-out, and the
  // fan-out is what approval releases. Until then the packet reports what it
  // KNOWS — how many people came off the pages.
  memberIds: [],
  extractedCount: 6,
  bulkApprove: {
    approvable: 5,
    total: 6,
    blockedNote: "Diego Diaz is blocked (inactive in UCPath) and is excluded.",
    editNote: "Changing any extracted value opens the review — a value may only be edited with its scanned page on screen.",
  },
  reviewRunId: "ocr-summer",
  outcome: {
    tone: "warning",
    text: "Waiting on you — approve 5 of 6 people, or open the review to work through them.",
  },
  steps: [
    { label: "OCR extraction", state: "done", system: "i9", durationSec: 128, keyLines: ["6 people on 8 pages", "2 pages had no form"] },
    { label: "Roster match", state: "done", system: "i9", durationSec: 31, keyLines: ["6/6 matched to the July roster"] },
    { label: "Your review", state: "waiting", keyLines: ["0 of 6 reviewed", "5 approvable · 1 blocked"] },
    { label: "Signer fan-out", state: "pending", system: "ucpath", keyLines: ["member rows are created here"] },
    { label: "Rollup", state: "pending" },
  ],
  lines: [
    { ts: "2:20:12", kind: "event", text: "Upload started — Oath_Packet_Summer.pdf · 8 pages", step: "OCR extraction" },
    { ts: "2:22:20", kind: "ok", text: "6 records extracted · 2 pages had no readable form", duration: "2m 8s", step: "OCR extraction" },
    { ts: "2:22:51", kind: "ok", system: "i9", text: "Roster re-match — 6/6 matched to July_Roster.xlsx", duration: "31s", step: "Roster match" },
    { ts: "2:22:54", kind: "warn", text: "Diego Diaz — UCPath status Inactive (separated 06/30/2026), record blocked", step: "Roster match" },
    { ts: "2:22:55", kind: "warn", text: "Ben Brooks — EID read at 0.44 confidence, flagged for your eyes", step: "Roster match" },
    { ts: "2:22:56", kind: "pause", text: "Waiting on you — approve people to fan out signer tasks. Open the OCR review row to work through them.", card: "gate", step: "Your review" },
  ],
  data: [
    { step: "OCR extraction", dir: "read", field: "People found", value: "6 (8 pages)", system: "i9", ts: "2:22:20" },
    { step: "Roster match", dir: "read", field: "Roster rows matched", value: "6 / 6", system: "i9", ts: "2:22:51" },
    { step: "Signer fan-out", dir: "write", field: "Oath signatures", value: "5 approvable of 6", system: "ucpath", ts: "—", staged: true },
  ],
  gate: {
    kind: "approval",
    title: "Waiting on you — approve the people to sign",
    openedAt: at("14:22:31"),
    note: "Approve straight from here if the packet reads clean; open the review to look at each person beside their page. Approving fans out one signer task per approved person — that is when member rows appear. Diego Diaz is blocked (inactive) and is excluded from the count.",
    options: [
      { key: "approve-5", label: "Approve 5 of 6", intent: "primary", command: "resolve-gate", resolution: "approve:5" },
      { key: "open-review", label: "Open review", intent: "neutral", command: "resolve-gate", resolution: "open-review", icon: "review" },
      {
        key: "discard",
        label: "Discard packet",
        intent: "destructive",
        command: "resolve-gate",
        resolution: "discard",
        confirm: {
          title: "Discard Oath_Packet_Summer.pdf?",
          body: "All 6 extracted people are thrown away and no signer runs are created. Nothing has been written yet, so nothing is undone — but the packet has to be re-uploaded to try again.",
          confirmLabel: "Discard the packet",
          tone: "destructive",
        },
      },
    ],
  },
  receipt: {
    tone: "muted",
    headline: "Receipt — pending",
    note: "The packet receipt rolls up once every approved signer reaches a terminal state: who signed, when, and the CRM verification per person.",
  },
  shots: [
    { label: "Packet page 1", kind: "step" },
    { label: "Roster match report", kind: "step" },
  ],
};

const ocrSummer: DemoRowSpec = {
  id: "ocr-summer",
  rowType: "run",
  subjectKind: "file",
  workflowId: "ocr",
  title: "Oath_Packet_Summer.pdf",
  runId4: "d771",
  status: "waiting",
  run: 5,
  version: 8,
  enqueuedAt: at("14:20:06"),
  startedAt: at("14:20:12"),
  evidence: { confidence: "unknown" },
  containment: "linked",
  linkedParentId: "oath-summer",
  reviewOf: "oath-summer",
  records: SUMMER_RECORDS,
  // Depth 2 — the lookups this run delegated, collapsed into ONE Group Row in
  // the Person Lookup panel (S7). Visible from HERE and from that panel, never
  // from the packet (D10).
  linkedGroup: { ids: PL_SUMMER_IDS, noun: "lookups", panel: "Person Lookup", groupId: "pl-summer" },
  outcome: {
    tone: "warning",
    text: "6 people extracted — 0 reviewed · 1 blocked · 2 flagged. Approve to release the signers.",
  },
  steps: [
    { label: "Split pages", state: "done", system: "i9", durationSec: 9, keyLines: ["8 pages · 6 with a readable form"] },
    { label: "Read forms", state: "done", system: "i9", durationSec: 119, keyLines: ["tier-1 model · 6/6 read", "no fabricated SSNs detected"] },
    { label: "Roster match", state: "done", system: "i9", durationSec: 31 },
    {
      label: "Person lookup",
      state: "done",
      system: "ucpath",
      durationSec: 44,
      keyLines: ["6 delegated lookups · 1 inactive", "each lookup is its own run, listed per person in Review"],
    },
    { label: "Your review", state: "waiting" },
  ],
  lines: [
    { ts: "2:20:21", kind: "event", system: "i9", text: "Split 8 pages · 6 carry a readable oath form", step: "Split pages" },
    { ts: "2:22:20", kind: "ok", system: "i9", text: "6 records read — tier-1 vision model, no fabrication flags", duration: "1m 59s", step: "Read forms" },
    { ts: "2:22:51", kind: "ok", system: "i9", text: "Roster re-match — 6/6", step: "Roster match" },
    { ts: "2:23:35", kind: "warn", system: "ucpath", text: "Diego Diaz — person found but Inactive (separated 06/30/2026)", step: "Person lookup" },
    { ts: "2:23:40", kind: "pause", text: "Awaiting your review — 6 records, 5 approvable", card: "gate", step: "Your review" },
  ],
  data: [
    { step: "Read forms", dir: "read", field: "Records read", value: "6", system: "i9", ts: "2:22:20" },
    { step: "Person lookup", dir: "read", field: "Active people", value: "5 of 6", system: "ucpath", ts: "2:23:35" },
  ],
  gate: {
    kind: "approval",
    title: "Waiting on you — 6 people to review",
    openedAt: at("14:22:34"),
    note: "Each person is shown beside the page they were read from. Approve per person; the packet fans out only what you approved.",
    options: [
      { key: "approve-5", label: "Approve 5 of 6", intent: "primary", command: "resolve-gate", resolution: "approve:5" },
      { key: "reupload", label: "Reupload packet", intent: "neutral", command: "rerun-with-different-input", resolution: "reupload" },
      {
        key: "discard",
        label: "Discard",
        intent: "destructive",
        command: "resolve-gate",
        resolution: "discard",
        confirm: {
          title: "Discard these 6 records?",
          body: "The extraction is thrown away and Oath_Packet_Summer.pdf is released with no signers. Nothing has been written, so nothing is undone.",
          confirmLabel: "Discard the extraction",
          tone: "destructive",
        },
      },
    ],
  },
  receipt: { tone: "muted", headline: "Receipt — pending", note: "An OCR run's receipt records what was read and what you approved — the signing receipts belong to the member rows." },
  shots: [
    { label: "Page 2 · Alvarez", kind: "form" },
    { label: "Page 3 · Brooks", kind: "form" },
    { label: "Page 5 · Diaz", kind: "form" },
  ],
};

// ===========================================================================
// The completed packet's OCR review row — `linked` to oath-batch, terminal.
// It exists so a finished packet's member rows still have a page to point back
// at, and so the OCR panel shows a delegated run in a terminal state.
// ===========================================================================

function springRecord(i: number): DemoRecord {
  const name = `${FIRST[(i * 3) % 25]} ${LAST[(i * 7) % 10]}`;
  const eid = `105${pad(31000 + i * 91, 5)}`;
  return {
    id: `spring-rec-${i}`,
    name,
    eid,
    page: i + 1,
    pageNote: `page ${i + 1} of 12 · oath form`,
    state: "ready",
    fields: [
      { label: "Printed name", value: name, source: "paper", confidence: 0.96, editable: true },
      { label: "Employee ID", value: eid, source: "paper", confidence: 0.94, editable: true },
      { label: "Signature date", value: "05/02/2026", source: "paper", confidence: 0.95, editable: true },
      { label: "Department", value: "000371 · Student Health", source: "ucpath" },
    ],
    checks: [
      { label: "Roster match", state: "ok", value: `matched row ${i + 3}` },
      { label: "UCPath person", state: "ok", value: `1 active match · ${eid}` },
      { label: "Employee signed", state: "ok", value: "yes — on paper" },
    ],
    lookup: { trace: `pl-1106${pad(10 + i, 2)}-${pad(i, 2)}b2`, status: "verifiedDone", note: `resolved ${eid} from the printed name` },
  };
}

const ocrSpring: DemoRowSpec = {
  id: "ocr-spring",
  rowType: "run",
  subjectKind: "file",
  workflowId: "ocr",
  title: "Oath_Packet_Spring.pdf",
  runId4: "a19c",
  status: "verifiedDone",
  run: 4,
  version: 11,
  enqueuedAt: at("11:04:55"),
  startedAt: at("11:05:01"),
  endedAt: at("11:11:32"),
  evidence: { receiptId: "rcpt-oc-a19c", confidence: "verified" },
  containment: "linked",
  linkedParentId: "oath-batch",
  reviewOf: "oath-batch",
  records: Array.from({ length: 12 }, (_, i) => springRecord(i)),
  outcome: { tone: "success", text: "12 of 12 read and approved at 11:12 AM — the packet fanned out 12 signers" },
  steps: [
    { label: "Split pages", state: "done", system: "i9", durationSec: 11 },
    { label: "Read forms", state: "done", system: "i9", durationSec: 178, keyLines: ["tier-1 model · 12/12 read"] },
    { label: "Roster match", state: "done", system: "i9", durationSec: 28 },
    { label: "Person lookup", state: "done", system: "ucpath", durationSec: 74, keyLines: ["12 delegated lookups · all active"] },
    { label: "Your review", state: "done", durationSec: 100, keyLines: ["approved 12/12 at 11:12 AM"] },
  ],
  lines: [
    { ts: "11:05:42", kind: "event", system: "i9", text: "Split 12 pages · 12 carry a readable oath form", step: "Split pages" },
    { ts: "11:08:40", kind: "ok", system: "i9", text: "12 records read — no fabrication flags", duration: "2m 58s", step: "Read forms" },
    { ts: "11:10:22", kind: "ok", system: "ucpath", text: "12 delegated person lookups complete — all active", step: "Person lookup" },
    { ts: "11:12:02", kind: "event", text: "You approved 12 of 12 — the packet released its signers", step: "Your review" },
  ],
  data: [
    { step: "Read forms", dir: "read", field: "Records read", value: "12", system: "i9", ts: "11:08:40" },
    { step: "Person lookup", dir: "read", field: "Active people", value: "12 of 12", system: "ucpath", ts: "11:10:22" },
  ],
  receipt: {
    tone: "success",
    headline: "Verified done · 12 of 12 approved",
    lines: [
      { label: "Read", value: "12 records · 12 pages", verified: true },
      { label: "Approved", value: "12 of 12 · 11:12 AM", verified: true },
      { label: "Released", value: "12 signer tasks on Oath_Packet_Spring.pdf" },
    ],
    note: "An OCR run's receipt records what was read and what you approved. The signing receipts belong to the member rows on the packet.",
  },
  shots: [{ label: "Page 1 · Alvarez", kind: "form" }],
};

// ===========================================================================
// Oath Upload — ONE Run Row, not a group.
//
// The document files ONE ServiceNow ticket, so the row is the document. Its
// signers are `linked`, not `member`: each one is an Oath Signature run with
// its own row in the Oath Signature panel. The upload row shows a chip that
// jumps there. Copying those signers under the upload row would double both
// the rows and the counts, and would put the same person in two panels.
// ===========================================================================

const OU_SIGNER_IDS = Array.from({ length: 6 }, (_, i) => `ou-s-${i}`);

/**
 * The signers a single uploaded PDF fanned out to. Each one is a REAL Oath
 * Signature run that lives in the Oath Signature panel (D6: oath-upload is ONE
 * Run Row and its signers are `linked` children, never a member list) — so each
 * carries its own start instant and its own recorded duration.
 */
const OU_SIGNERS: { name: string; eid: string; status: ProposedStatus; startedAt?: string; durationSec?: number }[] = [
  { name: "Nadia Osei", eid: "10612004", status: "verifiedDone", startedAt: at("14:19:02"), durationSec: 28 },
  { name: "Ravi Chandran", eid: "10598337", status: "verifiedDone", startedAt: at("14:21:14"), durationSec: 31 },
  { name: "Lena Hoffmann", eid: "10604412", status: "verifiedDone", startedAt: at("14:24:06"), durationSec: 34 },
  { name: "Tobias Frey", eid: "10587760", status: "running", startedAt: agoSeconds(47) },
  { name: "Priya Anand", eid: "10620118", status: "queued" },
  { name: "Marcus Boone", eid: "10577903", status: "queued" },
];

function ouSigner(i: number): DemoRowSpec {
  const s = OU_SIGNERS[i];
  const done = s.status === "verifiedDone";
  const running = s.status === "running";
  const signedAt = s.startedAt && s.durationSec !== undefined ? plusSeconds(s.startedAt, s.durationSec) : undefined;
  const signedClock = signedAt ? fmtClock(signedAt) : "";
  return {
    id: `ou-s-${i}`,
    rowType: "run",
    workflowId: "oath-signature",
    title: s.name,
    eid: s.eid,
    runId4: `s${pad(i, 3)}`,
    status: s.status,
    run: 1,
    version: 2,
    priority: "bulk",
    // linked, not member: this row is the signer's own run and lives here, in
    // the Oath Signature panel, exactly once.
    containment: "linked",
    linkedParentId: "ou-packet",
    enqueuedAt: at("14:18:40"),
    startedAt: s.startedAt,
    endedAt: signedAt,
    evidence: done ? { receiptId: `rcpt-os-s${pad(i, 3)}`, confidence: "verified" } : { confidence: "unknown" },
    queueNote: s.status === "queued" ? "in queue · behind the running signer" : undefined,
    liveText: running ? "Signing oath — UCPath signature canvas" : undefined,
    outcome: done
      ? { tone: "success", text: `Oath signed ${signedClock} — CRM verified` }
      : running
        ? { tone: "info", text: "Running — signing the oath in UCPath" }
        : { tone: "muted", text: "Queued — a worker picks this signer up next" },
    steps: done
      ? [
          { label: "CRM verify", state: "done", system: "crm", durationSec: 9 },
          { label: "UCPath auth", state: "done", system: "ucpath", durationSec: 6 },
          { label: "Sign oath", state: "done", system: "ucpath", durationSec: 13 + i, hasShot: true },
        ]
      : running
        ? [
            { label: "CRM verify", state: "done", system: "crm", durationSec: 10 },
            { label: "UCPath auth", state: "done", system: "ucpath", durationSec: 7 },
            { label: "Sign oath", state: "current", system: "ucpath" },
          ]
        : [
            { label: "CRM verify", state: "pending", system: "crm" },
            { label: "UCPath auth", state: "pending", system: "ucpath" },
            { label: "Sign oath", state: "pending", system: "ucpath" },
          ],
    lines: done
      ? [
          { ts: fmtClockSec(plusSeconds(s.startedAt ?? "", 9)), kind: "ok", system: "crm", text: "CRM onboarding record verified", step: "CRM verify" },
          {
            ts: fmtClockSec(signedAt ?? ""),
            kind: "write",
            system: "ucpath",
            pills: [{ dir: "write", label: "oath signed", value: signedClock }],
            step: "Sign oath",
          },
        ]
      : running
        ? [{ ts: fmtClockSec(agoSeconds(43)), kind: "nav", system: "ucpath", text: "Signature canvas open", step: "Sign oath" }]
        : [{ ts: "2:18:40", kind: "event", text: "Enqueued by Signed_Oaths_0724.pdf — waiting for a worker", step: "Queued" }],
    data: done
      ? [{ step: "Sign oath", dir: "write", field: "Oath signature", value: signedClock, system: "ucpath", ts: fmtClockSec(signedAt ?? "") }]
      : [],
    receipt: done
      ? {
          tone: "success",
          headline: "Verified done · oath signed",
          lines: [
            { label: "Signed", value: signedClock, verified: true },
            { label: "From", value: "Signed_Oaths_0724.pdf" },
          ],
        }
      : { tone: "muted", headline: "Receipt — pending", note: "Nothing signed for this person yet." },
    shots: done ? [{ label: "Signed oath", kind: "step" }] : [],
  };
}

// ===========================================================================
// Document + catalog Run Rows — the two Run Row variants the rest of the demo
// does not otherwise exercise.
// ===========================================================================

const ouPacket: DemoRowSpec = {
  id: "ou-packet",
  rowType: "run",
  subjectKind: "file",
  workflowId: "oath-upload",
  title: "Signed_Oaths_0724.pdf",
  runId4: "3b8e",
  status: "running",
  run: 7,
  version: 19,
  priority: "bulk",
  enqueuedAt: at("14:11:58"),
  startedAt: at("14:12:04"),
  evidence: { confidence: "unknown" },
  liveText: "Waiting on signatures — 3 of 6 signers done",
  // The signers are LINKED runs in the Oath Signature panel. This is a chip,
  // not a member list: one row, one home, one count.
  linkedGroup: { ids: OU_SIGNER_IDS, noun: "signers", panel: "Oath Signature" },
  facts: [
    { label: "pages", value: "6" },
    { label: "ticket", value: "filed after signing" },
  ],
  outcome: {
    tone: "info",
    text: "Waiting on signatures — 3 of 6 signed. The ticket is filed by this row once every signer is terminal.",
  },
  steps: [
    { label: "OCR prep", state: "done", system: "i9", durationSec: 96, keyLines: ["6 signed oaths recognised"] },
    { label: "Your review", state: "done", durationSec: 141, keyLines: ["approved 6/6 at 10:15 AM"] },
    { label: "Wait signatures", state: "current", system: "ucpath", keyLines: ["3 of 6 signers done", "each signer is its own run in the Oath Signature panel"] },
    { label: "File ticket", state: "pending", system: "servicenow" },
  ],
  lines: [
    { ts: "2:12:04", kind: "event", text: "Upload — Signed_Oaths_0724.pdf · 6 pages", step: "OCR prep" },
    { ts: "2:13:40", kind: "ok", system: "i9", text: "6 signed oaths recognised · all 6 matched to UCPath records", step: "OCR prep" },
    { ts: "2:15:01", kind: "event", text: "You approved 6 of 6", step: "Your review" },
    {
      ts: "2:15:04",
      kind: "event",
      text: "Released 6 signer runs into the Oath Signature panel — they are linked, not copied: this row waits on them and shows a chip",
      step: "Wait signatures",
    },
    { ts: "2:24:12", kind: "ok", system: "ucpath", text: "3 of 6 signers done — waiting on the remaining 3", step: "Wait signatures" },
  ],
  data: [
    { step: "OCR prep", dir: "read", field: "Signed oaths found", value: "6", system: "i9", ts: "2:13:40" },
    { step: "File ticket", dir: "write", field: "ServiceNow ticket", value: "one ticket for the document", system: "servicenow", ts: "—", staged: true },
  ],
  receipt: {
    tone: "muted",
    headline: "Receipt — pending",
    note: "One row, one document, one ticket: this workflow files its own ServiceNow ticket once all 6 signers are terminal — it does not fan out into members.",
  },
  shots: [
    { label: "Upload page 1", kind: "step" },
    { label: "Approval snapshot", kind: "form" },
  ],
};

const krReports: DemoRowSpec = {
  id: "kr-reports",
  rowType: "run",
  subjectKind: "catalog",
  workflowId: "kronos-reports",
  title: "Pay-period exception reports",
  // THE RENAMED SPECIMEN — the operator's own name rides the row and the
  // receipt; the trace id underneath is untouched, so history still matches.
  displayName: "Friday exception pack",
  runId4: "6c22",
  status: "running",
  run: 12,
  version: 6,
  enqueuedAt: at("14:04:48"),
  startedAt: at("14:04:55"),
  evidence: { confidence: "unknown" },
  liveText: "Downloading report 4 of 7 — Missed Punch Detail",
  facts: [
    { label: "selection", value: "7 reports" },
    { label: "period", value: "07/06 – 07/19" },
  ],
  outcome: { tone: "info", text: "Running — 3 of 7 reports downloaded · 4 workers" },
  steps: [
    { label: "Kronos auth", state: "done", system: "kronos", durationSec: 26 },
    { label: "Select reports", state: "done", system: "kronos", durationSec: 18, keyLines: ["7 of 34 catalog reports selected"] },
    { label: "Download", state: "current", system: "kronos" },
    { label: "Archive", state: "pending" },
  ],
  lines: [
    { ts: "2:04:55", kind: "ok", system: "kronos", text: "Authenticated · 4 download workers", step: "Kronos auth" },
    { ts: "2:05:41", kind: "ok", system: "kronos", text: "Selected 7 reports for 07/06 – 07/19", step: "Select reports" },
    { ts: "2:07:02", kind: "write", system: "kronos", pills: [{ dir: "write", label: "saved", value: "Hours_Detail.xlsx" }], step: "Download" },
    { ts: "2:09:14", kind: "write", system: "kronos", pills: [{ dir: "write", label: "saved", value: "Overtime_Summary.xlsx" }], step: "Download" },
    { ts: "2:10:48", kind: "write", system: "kronos", pills: [{ dir: "write", label: "saved", value: "Comp_Time.xlsx" }], step: "Download" },
  ],
  data: [
    { step: "Select reports", dir: "read", field: "Reports selected", value: "7 of 34", system: "kronos", ts: "2:05:41" },
    { step: "Download", dir: "write", field: "Files saved", value: "3 of 7", system: "kronos", ts: "2:10:48" },
  ],
  receipt: { tone: "muted", headline: "Receipt — pending", note: "Lists every file saved with its size and the pay period it covers, once all 7 finish." },
  shots: [{ label: "Report picker", kind: "form" }],
};

// ===========================================================================
// Roster Group Row at the scroll-well rung — too many for a readable inline
// list. The well keeps the row a fixed height; the 50-person I-9 roster below
// renders in exactly this shape, at exactly this height.
// ===========================================================================

const wsMemberIds = Array.from({ length: 18 }, (_, i) => `ws-m-${i}`);

const WS_SPECIAL: Record<number, ProposedStatus> = { 5: "doneWarnings", 12: "running", 16: "queued", 17: "queued" };

function wsMember(i: number): DemoRowSpec {
  const name = `${FIRST[(i * 5) % 25]} ${LAST[(i * 3) % 10]}`;
  const eid = `106${pad(12000 + i * 211, 5)}`;
  const status: ProposedStatus = WS_SPECIAL[i] ?? "verifiedDone";
  const startedAt = at(`14:${pad(8 + i, 2)}:${pad((i * 11) % 60, 2)}`);
  const ts = fmtClockSec(startedAt);
  const base: Omit<DemoRowSpec, "outcome" | "steps" | "lines" | "receipt"> = {
    id: `ws-m-${i}`,
    rowType: "member",
    parentId: "ws-batch",
    containment: "member",
    workflowId: "work-study",
    title: name,
    eid,
    runId4: `w${pad(i, 3)}`,
    status,
    run: 1,
    version: 2,
    priority: "bulk",
    enqueuedAt: at("14:07:04"),
    startedAt,
    data: [],
    shots: [],
  };
  const doneSteps: DemoStep[] = [
    { label: "UCPath auth", state: "done", system: "ucpath", durationSec: 7 },
    { label: "Transaction", state: "done", system: "ucpath", durationSec: 22 + (i % 6), hasShot: true },
  ];
  if (status === "running") {
    return {
      ...base,
      startedAt: agoSeconds(51),
      memberFact: "filling transaction…",
      liveText: "UCPath transaction — effective 07/01/2026",
      outcome: { tone: "info", text: "Running — filling the work-study transaction" },
      steps: [
        { label: "UCPath auth", state: "done", system: "ucpath", durationSec: 8 },
        { label: "Transaction", state: "current", system: "ucpath" },
      ],
      lines: [{ ts: fmtClockSec(agoSeconds(44)), kind: "nav", system: "ucpath", text: "Work-study transaction template open", step: "Transaction" }],
      receipt: { tone: "muted", headline: "Receipt — pending", note: "Still running." },
    };
  }
  if (status === "queued") {
    return {
      ...base,
      startedAt: undefined,
      memberFact: "—",
      queueNote: `in queue · position ${i - 15}`,
      outcome: { tone: "muted", text: "Queued behind the running person" },
      steps: [
        { label: "UCPath auth", state: "pending", system: "ucpath" },
        { label: "Transaction", state: "pending", system: "ucpath" },
      ],
      lines: [{ ts: "2:07:04", kind: "event", text: "Fanned out from the typed roster", step: "Queued" }],
      receipt: { tone: "muted", headline: "Receipt — pending", note: "Nothing has run yet." },
    };
  }
  if (status === "doneWarnings") {
    return {
      ...base,
      endedAt: plusSeconds(startedAt, 38),
      evidence: { receiptId: `rcpt-ws-w${pad(i, 3)}`, confidence: "partial" },
      memberFact: "effective date moved",
      warnings: { count: 1, first: "effective date fell before the pay period — moved to 07/01" },
      outcome: { tone: "warning", text: "Saved with 1 warning — the effective date was moved to the pay-period start" },
      steps: doneSteps,
      lines: [{ ts, kind: "warn", system: "ucpath", text: "Effective 06/28 is before the pay period — used 07/01 instead", step: "Transaction" }],
      receipt: {
        tone: "warning",
        headline: "Done with warnings · saved",
        lines: [
          { label: "Effective date", value: "07/01/2026 (requested 06/28)", verified: true },
          { label: "Award", value: "$2,400", verified: true },
        ],
      },
    };
  }
  return {
    ...base,
    endedAt: plusSeconds(startedAt, 24 + (i % 7)),
    evidence: { receiptId: `rcpt-ws-w${pad(i, 3)}`, confidence: "verified" },
    memberFact: `award $${2000 + i * 100}`,
    outcome: { tone: "success", text: `Work-study award saved and read back — $${2000 + i * 100}` },
    steps: doneSteps,
    lines: [{ ts, kind: "write", system: "ucpath", pills: [{ dir: "write", label: "award", value: `$${2000 + i * 100}` }], step: "Transaction" }],
    receipt: {
      tone: "success",
      headline: "Verified done · award saved",
      lines: [
        { label: "Award", value: `$${2000 + i * 100}`, verified: true },
        { label: "Effective", value: "07/01/2026", verified: true },
      ],
    },
  };
}

const wsBatch: DemoRowSpec = {
  id: "ws-batch",
  rowType: "group",
  subjectKind: "person",
  workflowId: "work-study",
  title: "Work-study awards — 18 people",
  runId4: "2d5f",
  status: "running",
  run: 3,
  version: 27,
  priority: "bulk",
  enqueuedAt: at("14:06:58"),
  startedAt: at("14:07:04"),
  evidence: { confidence: "unknown" },
  memberIds: wsMemberIds,
  ocrPhase: "16 of 18 processed — 1 running, 2 queued",
  outcome: { tone: "info", text: "Fan-out running — 16 of 18 processed · 1 flagged" },
  steps: [
    { label: "Parse input", state: "done", durationSec: 3, keyLines: ["18 typed EIDs · all resolved"] },
    { label: "Member fan-out", state: "current", system: "ucpath" },
    { label: "Rollup", state: "pending" },
  ],
  lines: [
    { ts: "2:07:04", kind: "event", text: "18 people typed into the input panel — one group, not 18 loose rows", step: "Parse input" },
    { ts: "2:07:07", kind: "event", text: "Fanned out 18 member tasks", step: "Member fan-out" },
    { ts: "2:18:41", kind: "warn", text: "1 member moved an effective date to the pay-period start", step: "Member fan-out" },
  ],
  data: [{ step: "Parse input", dir: "read", field: "People typed", value: "18", system: "ucpath", ts: "2:07:04" }],
  receipt: { tone: "muted", headline: "Receipt — pending", note: "Rolls up when all 18 members are terminal — every award with the value read back after save." },
  shots: [],
};

// ===========================================================================
// A packet whose only remaining problem is a rejected page. Rejected rows are
// counted separately and excluded from the rollup — but they still stop the
// packet reading as clean, so it settles at Done with warnings until each one
// is deleted or acknowledged.
// ===========================================================================

const ecPacketMemberIds = Array.from({ length: 6 }, (_, i) => `ecp-m-${i}`);
const EC_REJECTED_INDEX = 5;

function ecPacketMember(i: number): DemoRowSpec {
  const rejected = i === EC_REJECTED_INDEX;
  const name = rejected ? "Page 7" : `${FIRST[(i * 9) % 25]} ${LAST[(i * 4) % 10]}`;
  const eid = `104${pad(41000 + i * 173, 5)}`;
  const startedAt = at(`11:${pad(31 + i, 2)}:${pad((i * 13) % 60, 2)}`);
  const ts = fmtClockSec(startedAt);
  if (rejected) {
    return {
      id: `ecp-m-${i}`,
      rowType: "member",
      parentId: "ec-packet",
      containment: "rejected",
      displayOnly: true,
      workflowId: "emergency-contact",
      title: name,
      runId4: `r${pad(i, 3)}`,
      status: "failed",
      run: 1,
      version: 1,
      // no task, no start, no end — a rejected page is work that never existed
      enqueuedAt: at("11:29:44"),
      evidence: { confidence: "unknown" },
      memberFact: "no contact block on the page",
      outcome: {
        tone: "muted",
        text: "Rejected page — the form has no emergency-contact block. Display-only: no task exists, delete is the only action.",
      },
      steps: [{ label: "OCR extraction", state: "failed", system: "i9", keyLines: ["page 7: no contact fields detected"] }],
      lines: [{ ts: "11:29:44", kind: "warn", system: "i9", text: "Page 7 — no emergency-contact block; the page cannot become work", step: "OCR extraction" }],
      data: [],
      receipt: { tone: "muted", headline: "No receipt — rejected page", note: "Delete it once you have confirmed the page is a cover sheet or a duplicate scan." },
      shots: [],
    };
  }
  return {
    id: `ecp-m-${i}`,
    rowType: "member",
    parentId: "ec-packet",
    containment: "member",
    workflowId: "emergency-contact",
    title: name,
    eid,
    runId4: `m${pad(i, 3)}`,
    status: "verifiedDone",
    run: 1,
    version: 2,
    priority: "bulk",
    enqueuedAt: at("11:31:10"),
    startedAt,
    endedAt: plusSeconds(startedAt, 29 + i * 4),
    evidence: { receiptId: `rcpt-ec-m${pad(i, 3)}`, confidence: "verified" },
    memberFact: `contact saved · ${["spouse", "parent", "sibling", "partner", "parent"][i]}`,
    outcome: { tone: "success", text: "Emergency contact saved and read back from UCPath" },
    steps: [
      { label: "Navigation", state: "done", system: "ucpath", durationSec: 8 },
      { label: "Fill form", state: "done", system: "ucpath", durationSec: 14 + i },
      { label: "Save", state: "done", system: "ucpath", durationSec: 7, hasShot: true },
    ],
    lines: [{ ts, kind: "write", system: "ucpath", pills: [{ dir: "write", label: "contact", value: ["spouse", "parent", "sibling", "partner", "parent"][i] }], step: "Fill form" }],
    data: [{ step: "Fill form", dir: "write", field: "Relationship", value: ["spouse", "parent", "sibling", "partner", "parent"][i], system: "ucpath", ts }],
    receipt: {
      tone: "success",
      headline: "Verified done · contact saved",
      lines: [{ label: "Relationship", value: ["spouse", "parent", "sibling", "partner", "parent"][i], verified: true }],
    },
    shots: [{ label: "Saved contact", kind: "step" }],
  };
}

const ecPacket: DemoRowSpec = {
  id: "ec-packet",
  rowType: "group",
  subjectKind: "file",
  workflowId: "emergency-contact",
  title: "EC_Forms_0722.pdf",
  runId4: "9b31",
  status: "doneWarnings",
  run: 2,
  version: 16,
  priority: "bulk",
  enqueuedAt: at("11:27:54"),
  startedAt: at("11:28:02"),
  endedAt: at("11:32:08"),
  evidence: { receiptId: "rcpt-ec-9b31", confidence: "partial" },
  memberIds: ecPacketMemberIds,
  warnings: { count: 1, first: "1 page could not be turned into work" },
  outcome: {
    tone: "warning",
    text: "5 done · 1 rejected — the packet stays at Done with warnings until the rejected page is deleted or acknowledged.",
  },
  steps: [
    { label: "OCR extraction", state: "done", system: "i9", durationSec: 88, keyLines: ["6 pages · 5 with a contact block"] },
    { label: "Your review", state: "done", durationSec: 61, keyLines: ["approved 5/5 at 3:31 PM"] },
    { label: "Member fan-out", state: "done", system: "ucpath", durationSec: 92 },
    { label: "Rollup", state: "done", durationSec: 2, keyLines: ["5 verified · 1 rejected page excluded from the rollup"] },
  ],
  lines: [
    { ts: "11:28:02", kind: "event", text: "Upload — EC_Forms_0722.pdf · 6 pages", step: "OCR extraction" },
    { ts: "11:29:44", kind: "warn", system: "i9", text: "Page 7 has no contact block — rejected member row emitted (delete-only)", step: "OCR extraction" },
    { ts: "11:31:10", kind: "event", text: "You approved 5 of 5 readable records", step: "Your review" },
    { ts: "11:32:08", kind: "ok", text: "All 5 contacts saved and read back", step: "Member fan-out" },
    {
      ts: "11:32:10",
      kind: "warn",
      text: "Rollup — 5 of 5 real members verified, but 1 rejected page is unresolved, so the packet is Done with warnings, not Verified done",
      step: "Rollup",
    },
  ],
  data: [
    { step: "OCR extraction", dir: "read", field: "Pages with a contact block", value: "5 of 6", system: "i9", ts: "11:29:44" },
    { step: "Member fan-out", dir: "write", field: "Contacts saved", value: "5 of 5", system: "ucpath", ts: "11:32:08" },
  ],
  receipt: {
    tone: "warning",
    headline: "Done with warnings · 5 saved · 1 rejected",
    lines: [
      { label: "Saved", value: "5 contacts · read back", verified: true },
      { label: "Rejected", value: "Page 7 — no contact block, never became work" },
    ],
    members: [0, 1, 2, 3, 4].map((i) => ({
      name: `${FIRST[(i * 9) % 25]} ${LAST[(i * 4) % 10]}`,
      value: `EC-2026-${pad(7710 + i * 3, 4)}`,
      verified: true,
    })),
    note: "A rejected page is not a failure and not a success — it is work that never existed. Delete it (or acknowledge it) and the packet settles to Verified done.",
  },
  shots: [
    { label: "Packet page 1", kind: "step" },
    { label: "Page 7 (rejected)", kind: "error" },
  ],
};

// ===========================================================================
// A group of exactly one. It stays a Group Row: collapsing it to a plain Run
// Row would make an upload of one person look structurally different from an
// upload of six, and would hide the packet the person came from.
// ===========================================================================

const ecSingleMember: DemoRowSpec = {
  id: "ecs-m-0",
  rowType: "member",
  parentId: "ec-single",
  containment: "member",
  workflowId: "emergency-contact",
  title: "Yara Ito",
  eid: "10466920",
  runId4: "m000",
  status: "verifiedDone",
  run: 1,
  version: 3,
  enqueuedAt: at("12:04:52"),
  startedAt: at("12:05:00"),
  endedAt: at("12:05:31"),
  evidence: { receiptId: "rcpt-ec-m000", confidence: "verified" },
  memberFact: "contact saved · parent",
  outcome: { tone: "success", text: "Emergency contact saved and read back from UCPath" },
  steps: [
    { label: "Navigation", state: "done", system: "ucpath", durationSec: 9 },
    { label: "Fill form", state: "done", system: "ucpath", durationSec: 15 },
    { label: "Save", state: "done", system: "ucpath", durationSec: 7, hasShot: true },
  ],
  lines: [{ ts: "12:05:31", kind: "write", system: "ucpath", pills: [{ dir: "write", label: "contact", value: "parent" }], step: "Fill form" }],
  data: [{ step: "Fill form", dir: "write", field: "Relationship", value: "parent", system: "ucpath", ts: "12:05:31" }],
  receipt: {
    tone: "success",
    headline: "Verified done · contact saved",
    lines: [{ label: "Relationship", value: "parent", verified: true }],
  },
  shots: [{ label: "Saved contact", kind: "step" }],
};

const ecSingle: DemoRowSpec = {
  id: "ec-single",
  rowType: "group",
  subjectKind: "file",
  workflowId: "emergency-contact",
  title: "EC_Form_Ito.pdf",
  runId4: "3a77",
  status: "verifiedDone",
  run: 1,
  version: 6,
  enqueuedAt: at("12:04:06"),
  startedAt: at("12:04:12"),
  endedAt: at("12:06:00"),
  evidence: { receiptId: "rcpt-ec-3a77", confidence: "verified" },
  memberIds: ["ecs-m-0"],
  outcome: { tone: "success", text: "1 of 1 saved — a packet of one is still a packet" },
  steps: [
    { label: "OCR extraction", state: "done", system: "i9", durationSec: 34, keyLines: ["1 page · 1 contact block"] },
    { label: "Your review", state: "done", durationSec: 41 },
    { label: "Member fan-out", state: "done", system: "ucpath", durationSec: 31 },
    { label: "Rollup", state: "done", durationSec: 2 },
  ],
  lines: [
    { ts: "12:04:12", kind: "event", text: "Upload — EC_Form_Ito.pdf · 1 page", step: "OCR extraction" },
    { ts: "12:05:02", kind: "event", text: "You approved 1 of 1", step: "Your review" },
    { ts: "12:06:00", kind: "ok", text: "Rollup complete — 1 contact saved", step: "Rollup" },
  ],
  data: [{ step: "Member fan-out", dir: "write", field: "Contacts saved", value: "1 of 1", system: "ucpath", ts: "12:06:00" }],
  receipt: {
    tone: "success",
    headline: "Verified done · 1 of 1 saved",
    lines: [{ label: "Source packet", value: "EC_Form_Ito.pdf · 1 page" }],
    members: [{ name: "Yara Ito", value: "EC-2026-7801", verified: true }],
    note: "One member is still a member: the person keeps her own run, receipt and retry, and the packet keeps the page she came from.",
  },
  shots: [{ label: "Page 1", kind: "step" }],
};

// ===========================================================================
// A packet that FAILED because its linked OCR child failed. The parent takes
// the child's status and mirrors its error — Waiting on you would be a lie
// here, because nobody is being asked to decide anything: something broke.
// ===========================================================================

const ocrOnbase: DemoRowSpec = {
  id: "ocr-onbase",
  rowType: "run",
  subjectKind: "file",
  workflowId: "ocr",
  title: "OnBase_Import_0722.pdf",
  runId4: "e440",
  status: "failed",
  run: 2,
  version: 4,
  enqueuedAt: at("11:58:55"),
  startedAt: at("11:59:02"),
  endedAt: at("12:00:14"),
  evidence: { failureId: "fail-oc-e440", confidence: "unknown" },
  containment: "linked",
  linkedParentId: "ob-packet",
  reviewOf: "ob-packet",
  records: [],
  error: "0 of 14 pages were readable — the PDF is a flattened fax scan at 96 dpi",
  failShots: 2,
  outcome: { tone: "destructive", text: "OCR failed — 0 of 14 pages readable (96 dpi fax scan)" },
  steps: [
    { label: "Split pages", state: "done", system: "i9", durationSec: 8, keyLines: ["14 pages"] },
    { label: "Read forms", state: "failed", system: "i9", durationSec: 64, attempts: 2, keyLines: ["0 of 14 pages produced a record", "page raster is 96 dpi — below the readable floor"] },
    { label: "Roster match", state: "pending", system: "i9" },
    { label: "Your review", state: "pending" },
  ],
  lines: [
    { ts: "11:59:10", kind: "event", system: "i9", text: "Split 14 pages", step: "Split pages" },
    { ts: "12:00:14", kind: "error", system: "i9", text: "0 of 14 pages produced a record — the raster is 96 dpi, below the readable floor", card: "failure", step: "Read forms" },
  ],
  data: [{ step: "Read forms", dir: "read", field: "Records read", value: "0 of 14", system: "i9", ts: "12:00:14" }],
  receipt: {
    tone: "destructive",
    headline: "No receipt — nothing was read",
    lines: [
      { label: "Failed at", value: "Read forms · attempt 2" },
      { label: "Error", value: "0 of 14 pages readable (96 dpi)" },
    ],
    note: "Re-scan at 300 dpi and re-upload. Nothing was written anywhere and no member rows were created.",
  },
  shots: [
    { label: "Page 1 raster", kind: "error" },
    { label: "Read attempt 2", kind: "error" },
  ],
  failCard: { title: "OCR could not read the packet", meta: "14 pages split, 0 records produced. The page raster is 96 dpi — a fax scan, not a document scan." },
};

const obPacket: DemoRowSpec = {
  id: "ob-packet",
  rowType: "group",
  subjectKind: "file",
  workflowId: "onbase",
  title: "OnBase_Import_0722.pdf",
  runId4: "1c08",
  status: "failed",
  run: 2,
  version: 5,
  enqueuedAt: at("11:58:52"),
  startedAt: at("11:59:00"),
  endedAt: at("12:00:20"),
  evidence: { failureId: "fail-ob-1c08", confidence: "unknown" },
  memberIds: [],
  reviewRunId: "ocr-onbase",
  mirroredFrom: "ocr-onbase",
  error: "OCR failed — 0 of 14 pages were readable (96 dpi fax scan)",
  outcome: {
    tone: "destructive",
    text: "Failed — its OCR run could not read the packet: 0 of 14 pages readable (96 dpi fax scan)",
  },
  steps: [
    { label: "OCR extraction", state: "failed", system: "i9", durationSec: 72, keyLines: ["delegated to oc-155902-e440", "child failed — 0 of 14 pages readable"] },
    { label: "Your review", state: "pending" },
    { label: "Member fan-out", state: "pending", system: "onbase" },
    { label: "Rollup", state: "pending" },
  ],
  lines: [
    { ts: "11:59:00", kind: "event", text: "Upload — OnBase_Import_0722.pdf · 14 pages", step: "OCR extraction" },
    { ts: "11:59:02", kind: "event", text: "Delegated extraction to the OCR panel — oc-155902-e440", step: "OCR extraction" },
    {
      ts: "12:00:20",
      kind: "error",
      text: "The OCR run failed: 0 of 14 pages readable (96 dpi fax scan). There is nothing to review, so this packet is Failed — not Waiting on you.",
      card: "failure",
      step: "OCR extraction",
    },
  ],
  data: [],
  receipt: {
    tone: "destructive",
    headline: "No receipt — the packet never produced records",
    lines: [
      { label: "Failed at", value: "OCR extraction (delegated)" },
      { label: "Child run", value: "oc-155902-e440 — 0 of 14 pages readable" },
    ],
    note: "Re-scan at 300 dpi and re-upload. Nothing was imported into OnBase and no member rows exist.",
  },
  shots: [{ label: "Upload page 1", kind: "error" }],
  failCard: {
    title: "Delegated OCR failed — mirrored here",
    meta: "oc-155902-e440: 14 pages split, 0 records produced (96 dpi raster). Re-upload a 300 dpi scan.",
  },
};

// ===========================================================================
// S7 — the helper run seen from ITS OWN panel.
//
// Six person lookups delegated by one OCR run do NOT become six loose rows in
// the Person Lookup panel: they collapse into ONE Group Row titled by the
// parent, carrying a back chip to it. Each member says, in its Data tab, what
// the parent will do with the answer — without that line a delegated lookup is
// context-free.
//
// The member trace ids are the SAME ids the OCR review row prints against each
// record (`summerRecord`): both are `pl-<HHMMSS>-<runId4>` over the same
// instants, so the two surfaces cannot tell different stories about which run
// answered which record.
// ===========================================================================

function plSummerMember(i: number): DemoRowSpec {
  const p = SUMMER_PEOPLE[i];
  const startedAt = at(`14:23:${pad(20 + i * 3, 2)}`);
  const blocked = p.state === "blocked";
  const ts = fmtClockSec(plusSeconds(startedAt, 4));
  return {
    id: `pls-m-${i}`,
    rowType: "member",
    parentId: "pl-summer",
    containment: "member",
    workflowId: "person-lookup",
    title: p.name,
    eid: p.eid,
    runId4: `${pad(i, 2)}a1`,
    status: blocked ? "doneWarnings" : "verifiedDone",
    run: 1,
    version: 2,
    priority: "bulk",
    enqueuedAt: at("14:23:15"),
    startedAt,
    endedAt: plusSeconds(startedAt, 6 + (i % 3)),
    evidence: { receiptId: `rcpt-pl-${pad(i, 2)}a1`, confidence: "verified" },
    memberFact: blocked ? "found · INACTIVE" : `resolved ${p.eid}`,
    warnings: blocked ? { count: 1, first: "person is separated — the packet cannot sign them" } : undefined,
    feedsInto: {
      label: `Oath_Packet_Summer.pdf · record ${i + 1} (${p.name}) EID`,
      targetRunId: "ocr-summer",
    },
    outcome: blocked
      ? { tone: "warning", text: "Found the person, but UCPath reports them separated — the packet blocks this record" }
      : { tone: "success", text: `Resolved ${p.name} → ${p.eid} from the printed name` },
    steps: [
      { label: "Searching", state: "done", system: "ucpath", durationSec: 4, keyLines: [`input: “${p.name}” (read off page ${p.page})`] },
      { label: "Active status", state: "done", system: "ucpath", durationSec: 2 },
    ],
    lines: [
      { ts: fmtClockSec(startedAt), kind: "search", system: "ucpath", text: `Person search: “${p.name}” — 1 match`, step: "Searching" },
      blocked
        ? { ts, kind: "warn", system: "ucpath", text: "HR status Inactive — separated 06/30/2026", step: "Active status" }
        : { ts, kind: "read", system: "ucpath", pills: [{ dir: "read", label: "EID", value: p.eid }], step: "Active status" },
    ],
    data: [
      { step: "Searching", dir: "read", field: "Employee ID", value: p.eid, system: "ucpath", ts },
      { step: "Active status", dir: "read", field: "HR status", value: blocked ? "Inactive" : "Active", system: "ucpath", ts },
    ],
    receipt: {
      tone: blocked ? "warning" : "success",
      headline: blocked ? "Done with warnings · person is inactive" : "Verified done · person resolved",
      lines: [
        { label: "Employee ID", value: p.eid, verified: true },
        { label: "HR status", value: blocked ? "Inactive — separated 06/30/2026" : "Active", verified: true },
      ],
      note: "Person Lookup writes nothing — its receipt records what was read and where it goes next.",
    },
    shots: [{ label: "UCPath search", kind: "step" }],
  };
}

const plSummer: DemoRowSpec = {
  id: "pl-summer",
  rowType: "group",
  subjectKind: "person",
  workflowId: "person-lookup",
  // no title of its own — the count + the parent name ARE the title (S7)
  title: "Oath_Packet_Summer.pdf",
  groupNoun: "lookups",
  runId4: "8c30",
  status: "verifiedDone",
  run: 7,
  version: 8,
  priority: "bulk",
  containment: "linked",
  linkedParentId: "ocr-summer",
  enqueuedAt: at("14:23:12"),
  startedAt: at("14:23:18"),
  endedAt: at("14:23:56"),
  evidence: { confidence: "verified" },
  memberIds: PL_SUMMER_IDS,
  feedsInto: {
    label: "Oath_Packet_Summer.pdf · one EID per extracted record",
    targetRunId: "ocr-summer",
  },
  outcome: {
    tone: "warning",
    text: "6 lookups done for the OCR run — 5 resolved active, 1 separated (that record is blocked upstream)",
  },
  steps: [
    { label: "Accept delegation", state: "done", durationSec: 2, keyLines: ["6 names handed over by oc-142012-d771"] },
    { label: "Member fan-out", state: "done", system: "ucpath", durationSec: 36 },
    { label: "Report back", state: "done", durationSec: 2, keyLines: ["6 answers returned to the OCR run"] },
  ],
  lines: [
    { ts: "2:23:18", kind: "event", text: "Delegated by the OCR run on Oath_Packet_Summer.pdf — 6 names, one lookup each", step: "Accept delegation" },
    { ts: "2:23:35", kind: "warn", system: "ucpath", text: "Diego Diaz — found, but Inactive (separated 06/30/2026)", step: "Member fan-out" },
    { ts: "2:23:56", kind: "ok", text: "6 answers reported back to oc-142012-d771", duration: "38s", step: "Report back" },
  ],
  data: [
    { step: "Member fan-out", dir: "read", field: "People resolved", value: "6 of 6", system: "ucpath", ts: "2:23:56" },
    { step: "Member fan-out", dir: "read", field: "Active", value: "5 of 6", system: "ucpath", ts: "2:23:56" },
  ],
  receipt: {
    tone: "success",
    headline: "Verified done · 6 lookups answered",
    lines: [{ label: "Delegated by", value: "OCR · Oath_Packet_Summer.pdf" }],
    members: SUMMER_PEOPLE.map((p) => ({ name: p.name, value: p.eid, verified: p.state !== "blocked", failed: false })),
    note: "Nothing was written. These answers are consumed by the OCR run's records — this group exists so the work is visible in the panel that executed it.",
  },
  shots: [],
};

// ===========================================================================
// S1 — looked someone up mid-run (separations, CONDITIONAL).
//
// The happy path never delegates at all; this is the branch that does. The run
// pauses, hands ONE sub-job to another workflow as a `linked` child (own row,
// own panel), and resumes with the answer. The parent shows a chip, never a
// copy of the child.
// ===========================================================================

const plNathan: DemoRowSpec = {
  id: "pl-nathan",
  rowType: "run",
  workflowId: "person-lookup",
  title: "Nathan Cole",
  runId4: "5b12",
  status: "running",
  run: 14,
  version: 2,
  containment: "linked",
  linkedParentId: "sep-nathan",
  enqueuedAt: at("14:25:02"),
  startedAt: at("14:25:09"),
  evidence: { confidence: "unknown" },
  liveText: "Searching UCPath — the Kuali name has no EID",
  feedsInto: {
    label: "Nathan Cole · separations identity check → EID for the termination write",
    targetRunId: "sep-nathan",
  },
  outcome: { tone: "info", text: "Running — resolving the EID the separations run needs before it can write" },
  steps: [
    { label: "Searching", state: "current", system: "ucpath" },
    { label: "Cross-verification", state: "pending", system: "crm" },
  ],
  lines: [
    { ts: "2:25:09", kind: "event", text: "Delegated by the separations run for Nathan Cole — the Kuali document carries no EID", step: "Searching" },
    { ts: "2:25:14", kind: "search", system: "ucpath", text: "Person search: “Nathan Cole”", step: "Searching" },
  ],
  data: [],
  receipt: { tone: "muted", headline: "Receipt — pending", note: "Read-only run. Its receipt records what was looked up and which run consumed the answer." },
  shots: [],
};

const sepNathan: DemoRowSpec = {
  id: "sep-nathan",
  rowType: "run",
  workflowId: "separations",
  title: "Nathan Cole",
  runId4: "a704",
  itemId: "kuali:5-TTQ8LP",
  status: "running",
  run: 5,
  version: 3,
  enqueuedAt: at("14:24:31"),
  startedAt: at("14:24:38"),
  evidence: { confidence: "unknown" },
  // ONE linked child. Same mechanism the Oath Upload row uses for six signers —
  // a set of one is still a set, and it still lives in its own panel.
  linkedGroup: { ids: ["pl-nathan"], noun: "person lookup", panel: "Person Lookup" },
  liveText: "Paused at Identity check — waiting on the delegated person lookup",
  outcome: { tone: "info", text: "Running — handed the identity check to Person Lookup, waiting for the EID" },
  steps: [
    { label: "Kuali extraction", state: "done", system: "kuali", durationSec: 27, keyLines: ["last day worked = 08/01/2026", "no employee ID on the document"] },
    { label: "Identity check", state: "current", system: "ucpath", keyLines: ["delegated to pl-142509-5b12", "this branch runs only when the document has no usable EID"] },
    { label: "Job summary", state: "pending", system: "ucpath" },
    { label: "Kronos search", state: "pending", system: "kronos" },
    { label: "UCPath transaction", state: "pending", system: "ucpath" },
    { label: "Kuali finalization", state: "pending", system: "kuali" },
  ],
  lines: [
    { ts: "2:24:38", kind: "nav", system: "kuali", text: "Opened separation document 5-TTQ8LP", step: "Kuali extraction" },
    { ts: "2:25:01", kind: "read", system: "kuali", pills: [{ dir: "read", label: "last day worked", value: "08/01/2026" }], step: "Kuali extraction" },
    {
      ts: "2:25:05",
      kind: "warn",
      text: "The document names a person but carries no employee ID — delegating a person lookup instead of guessing",
      step: "Identity check",
    },
    { ts: "2:25:09", kind: "event", text: "Delegated pl-142509-5b12 · this run resumes at Identity check when the answer comes back", step: "Identity check" },
  ],
  data: [{ step: "Kuali extraction", dir: "read", field: "Last day worked", value: "08/01/2026", system: "kuali", ts: "2:25:01" }],
  receipt: { tone: "muted", headline: "Receipt — pending", note: "Nothing written yet. The termination write cannot start until the delegated lookup returns an EID." },
  shots: [{ label: "Kuali doc 5-TTQ8LP", kind: "step" }],
};

const plDana: DemoRowSpec = {
  id: "pl-dana",
  rowType: "run",
  workflowId: "person-lookup",
  title: "Dana Whitmore",
  runId4: "e88f",
  status: "failed",
  run: 13,
  version: 3,
  containment: "linked",
  linkedParentId: "sep-dana",
  enqueuedAt: at("13:18:40"),
  startedAt: at("13:18:47"),
  endedAt: at("13:19:26"),
  evidence: { failureId: "fail-pl-e88f", confidence: "unknown" },
  failShots: 2,
  error: "UCPath person search returned 0 matches for “Dana Whitmore” — the name on the Kuali document is not a UCPath person",
  feedsInto: {
    label: "Dana Whitmore · separations identity check → EID for the termination write",
    targetRunId: "sep-dana",
  },
  outcome: {
    tone: "destructive",
    text: "Failed — 0 UCPath matches for “Dana Whitmore”; the separations run that asked for it is failed too",
  },
  steps: [
    { label: "Searching", state: "failed", system: "ucpath", durationSec: 39, attempts: 2, keyLines: ["0 matches on the full name", "0 matches on last name + department"] },
    { label: "Cross-verification", state: "pending", system: "crm" },
  ],
  lines: [
    { ts: "1:18:47", kind: "event", text: "Delegated by the separations run for Dana Whitmore", step: "Searching" },
    { ts: "1:19:02", kind: "search", system: "ucpath", text: "Person search: “Dana Whitmore” — 0 results", attempt: 1, step: "Searching" },
    { ts: "1:19:26", kind: "error", system: "ucpath", text: "0 matches on last name + dept 000371 either — refusing to guess a person", card: "failure", step: "Searching" },
  ],
  data: [],
  receipt: {
    tone: "destructive",
    headline: "No receipt — nobody was resolved",
    lines: [{ label: "Searched", value: "“Dana Whitmore” · dept 000371" }],
    note: "Nothing was written anywhere. Check the name on the Kuali document — a lookup that guesses is how the wrong person gets terminated.",
  },
  shots: [
    { label: "Search results (0)", kind: "error" },
    { label: "Name as typed", kind: "error" },
  ],
  failCard: { title: "Person lookup found nobody", meta: "0 matches on the full name and 0 on last-name + department. The name on the separation document does not exist in UCPath." },
};

const sepDana: DemoRowSpec = {
  id: "sep-dana",
  rowType: "run",
  workflowId: "separations",
  title: "Dana Whitmore",
  runId4: "31c6",
  itemId: "kuali:5-RWP2KD",
  status: "failed",
  run: 4,
  version: 5,
  enqueuedAt: at("13:18:11"),
  startedAt: at("13:18:18"),
  endedAt: at("13:19:28"),
  evidence: { failureId: "fail-se-31c6", confidence: "unknown" },
  linkedGroup: { ids: ["pl-dana"], noun: "person lookup", panel: "Person Lookup" },
  // D13: a failed linked child makes the parent Failed — never "Waiting on you",
  // because nobody is being asked to decide anything — and the child's error is
  // mirrored verbatim so the parent never says "Unknown error".
  mirroredFrom: "pl-dana",
  error: "Person lookup failed — UCPath person search returned 0 matches for “Dana Whitmore”",
  outcome: {
    tone: "destructive",
    text: "Failed — its person lookup found nobody: 0 UCPath matches for “Dana Whitmore”",
  },
  steps: [
    { label: "Kuali extraction", state: "done", system: "kuali", durationSec: 24, hasShot: true },
    { label: "Identity check", state: "failed", system: "ucpath", durationSec: 42, keyLines: ["delegated to pl-131847-e88f", "child failed — 0 matches, nothing to write against"] },
    { label: "Job summary", state: "pending", system: "ucpath" },
    { label: "Kronos search", state: "pending", system: "kronos" },
    { label: "UCPath transaction", state: "pending", system: "ucpath" },
    { label: "Kuali finalization", state: "pending", system: "kuali" },
  ],
  lines: [
    { ts: "1:18:18", kind: "nav", system: "kuali", text: "Opened separation document 5-RWP2KD", step: "Kuali extraction" },
    { ts: "1:18:47", kind: "event", text: "No EID on the document — delegated pl-131847-e88f", step: "Identity check" },
    {
      ts: "1:19:28",
      kind: "error",
      text: "The delegated lookup failed: UCPath person search returned 0 matches for “Dana Whitmore”. Nothing was written and no termination was staged.",
      card: "failure",
      step: "Identity check",
    },
  ],
  data: [{ step: "Kuali extraction", dir: "read", field: "Last day worked", value: "07/31/2026", system: "kuali", ts: "1:18:36" }],
  receipt: {
    tone: "destructive",
    headline: "No receipt — the run stopped at the identity check",
    lines: [
      { label: "Failed at", value: "Identity check (delegated)" },
      { label: "Child run", value: "pl-131847-e88f — 0 UCPath matches" },
    ],
    note: "Nothing was written to UCPath, Kronos or Kuali. Fix the name on the separation document, then retry the lookup — the retry replays the CHILD and this run resumes behind it.",
  },
  shots: [{ label: "Kuali doc 5-RWP2KD", kind: "step" }],
  failCard: {
    title: "Delegated person lookup failed — mirrored here",
    meta: "pl-131847-e88f searched “Dana Whitmore” in UCPath: 0 results on the name and 0 on last-name + dept 000371.",
  },
};

// ===========================================================================
// S5 — a list you typed.
//
// Five separations from five typed inputs: a Group Row with no OCR, no linked
// child and no packet. Every member runs the IDENTICAL step list, which is the
// one legitimate case of a group strip being a member aggregate — the strip is
// the shared pipeline with a per-step fill bar (`Identity check 3/5`).
//
// One member trips the identity gate, which flips the group to Waiting on you
// and auto-expands it (D5): you never have to open a row to find that out.
// ===========================================================================

const SEP_LIST_PEOPLE = ["Grace Egan", "Hugo Flores", "Iris Garcia", "Jonah Hahn", "Kara Ito"];
const SEP_LIST_IDS = SEP_LIST_PEOPLE.map((_, i) => `sep-l-${i}`);
const SEP_LIST_STEPS = ["Kuali extraction", "Identity check", "Job summary", "Kronos search", "UCPath transaction", "Kuali finalization"];

function sepListMember(i: number): DemoRowSpec {
  const name = SEP_LIST_PEOPLE[i];
  const eid = `105${pad(30000 + i * 317, 5)}`;
  const startedAt = at(`13:5${i}:0${(i * 3) % 10}`);
  const ts = fmtClockSec(plusSeconds(startedAt, 30));
  const status: ProposedStatus = i === 2 ? "waiting" : i === 3 ? "running" : i === 4 ? "queued" : "verifiedDone";
  const step = (label: string, state: StepState, system?: SystemKey, durationSec?: number): DemoStep => ({ label, state, system, durationSec });
  const base: Omit<DemoRowSpec, "outcome" | "steps" | "lines" | "receipt"> = {
    id: `sep-l-${i}`,
    rowType: "member",
    parentId: "sep-list",
    containment: "member",
    workflowId: "separations",
    title: name,
    eid: status === "queued" ? undefined : eid,
    runId4: `l${pad(i, 2)}c`,
    status,
    run: 1,
    version: 3,
    priority: "bulk",
    enqueuedAt: at("13:49:40"),
    startedAt: status === "queued" ? undefined : startedAt,
    data: [],
    shots: [],
  };
  if (status === "waiting") {
    return {
      ...base,
      memberFact: "identity approval",
      evidence: { confidence: "unknown" },
      outcome: { tone: "warning", text: "Paused on identity approval — the typed name matched a different person in UCPath" },
      steps: [
        step("Kuali extraction", "done", "kuali", 31),
        step("Identity check", "waiting", "ucpath"),
        step("Job summary", "pending", "ucpath"),
        step("Kronos search", "pending", "kronos"),
        step("UCPath transaction", "pending", "ucpath"),
        step("Kuali finalization", "pending", "kuali"),
      ],
      lines: [
        { ts, kind: "search", system: "ucpath", text: `Person search: “${name}” — 1 match with a different middle name`, step: "Identity check" },
        { ts, kind: "warn", text: "Resolved person differs from the typed name — pausing before any write", card: "gate", step: "Identity check" },
      ],
      data: [{ step: "Kuali extraction", dir: "read", field: "Last day worked", value: "07/28/2026", system: "kuali", ts }],
      gate: {
        kind: "identity",
        title: "Waiting on you — identity approval",
        openedAt: at("13:53:20"),
        candidates: [
          { heading: "As you typed it", name, sub: "no EID · typed into the input panel" },
          { heading: "UCPath name match (proposed)", name: "I. R. Garcia", sub: `${eid} · Dept 000482 · Lab Ast 2` },
        ],
        options: [
          { key: "use-eid", label: `Use ${eid}`, intent: "primary", command: "resolve-gate", resolution: `pick-eid:${eid}` },
          { key: "manual-eid", label: "Enter EID…", intent: "neutral", command: "resolve-gate", resolution: "manual-eid" },
          {
            key: "dismiss",
            label: "Dismiss",
            intent: "neutral",
            command: "resolve-gate",
            resolution: "dismiss",
            confirm: {
              title: "Drop this person from the list?",
              body: `${name} is removed from this group with nothing written. The other four separations are untouched and keep running.`,
              confirmLabel: "Drop this person",
              tone: "destructive",
            },
          },
        ],
        note: "Resolving returns this member to Running at Identity check. The other members never stopped — a group waits on nobody.",
      },
      receipt: { tone: "muted", headline: "Receipt — pending", note: "Nothing written. This member is holding the whole group at Waiting on you." },
    };
  }
  if (status === "running") {
    return {
      ...base,
      startedAt: agoSeconds(96),
      memberFact: "job summary…",
      liveText: "Job summary — reading the active job record",
      evidence: { confidence: "unknown" },
      outcome: { tone: "info", text: "Running — reading the job summary" },
      steps: [
        step("Kuali extraction", "done", "kuali", 28),
        step("Identity check", "done", "ucpath", 11),
        step("Job summary", "current", "ucpath"),
        step("Kronos search", "pending", "kronos"),
        step("UCPath transaction", "pending", "ucpath"),
        step("Kuali finalization", "pending", "kuali"),
      ],
      lines: [{ ts, kind: "nav", system: "ucpath", text: "Job summary open — active job record 0", step: "Job summary" }],
      receipt: { tone: "muted", headline: "Receipt — pending", note: "Still running." },
    };
  }
  if (status === "queued") {
    return {
      ...base,
      memberFact: "—",
      queueNote: "in queue · position 1",
      outcome: { tone: "muted", text: "Queued — one worker, five people; this one is last in line" },
      steps: SEP_LIST_STEPS.map((label) => step(label, "pending")),
      lines: [{ ts: "1:49:40", kind: "event", text: "Fanned out from the typed list", step: "Queued" }],
      receipt: { tone: "muted", headline: "Receipt — pending", note: "Nothing has run yet." },
    };
  }
  return {
    ...base,
    endedAt: plusSeconds(startedAt, 214 + i * 9),
    evidence: { receiptId: `rcpt-se-l${pad(i, 2)}`, confidence: "verified" },
    memberFact: `TXN-09${pad(11400 + i * 13, 5)}`,
    outcome: { tone: "success", text: `Terminated 07/31/2026 · TXN-09${pad(11400 + i * 13, 5)} read back` },
    steps: [
      step("Kuali extraction", "done", "kuali", 29 + i),
      step("Identity check", "done", "ucpath", 10),
      step("Job summary", "done", "ucpath", 19),
      step("Kronos search", "done", "kronos", 44),
      step("UCPath transaction", "done", "ucpath", 96),
      step("Kuali finalization", "done", "kuali", 22),
    ],
    lines: [
      { ts, kind: "write", system: "ucpath", pills: [{ dir: "write", label: "separation date", value: "07/31/2026" }], step: "UCPath transaction" },
      { ts, kind: "ok", text: `Transaction submitted — TXN-09${pad(11400 + i * 13, 5)} · read-back verified`, step: "UCPath transaction" },
    ],
    data: [
      { step: "Kuali extraction", dir: "read", field: "Last day worked", value: "07/30/2026", system: "kuali", ts },
      { step: "UCPath transaction", dir: "write", field: "Separation date", value: "07/31/2026", system: "ucpath", ts },
    ],
    receipt: {
      tone: "success",
      headline: "Verified done · termination submitted",
      lines: [
        { label: "Separation date", value: "07/31/2026", verified: true },
        { label: "Transaction", value: `TXN-09${pad(11400 + i * 13, 5)}`, verified: true },
      ],
    },
  };
}

const sepList: DemoRowSpec = {
  id: "sep-list",
  rowType: "group",
  subjectKind: "person",
  workflowId: "separations",
  // deliberately empty: the anchor of a typed list has no subject of its own,
  // so its title is the derived count and the member-name preview under it
  title: "",
  groupNoun: "separations",
  runId4: "6ff2",
  status: "running",
  run: 6,
  version: 12,
  priority: "bulk",
  enqueuedAt: at("13:49:31"),
  startedAt: at("13:49:40"),
  evidence: { confidence: "unknown" },
  memberIds: SEP_LIST_IDS,
  preset: {
    name: "July separations",
    source: "saved input preset",
    merged: [
      { field: "Termination type", value: "Voluntary" },
      { field: "Timekeeper", value: "J. Hein" },
      { field: "Notify supervisor", value: "yes" },
    ],
  },
  outcome: { tone: "warning", text: "One member is waiting on you — the other four are unaffected and still running" },
  steps: [
    { label: "Parse typed input", state: "done", durationSec: 2, keyLines: ["5 names typed · preset “July separations” merged"] },
    { label: "Member fan-out", state: "current" },
    { label: "Rollup", state: "pending" },
  ],
  lines: [
    { ts: "1:49:40", kind: "event", text: "5 names typed into the input panel — one group, not five loose rows", step: "Parse typed input" },
    { ts: "1:49:41", kind: "event", text: "Preset “July separations” merged 3 constant fields into every member", step: "Parse typed input" },
    { ts: "1:53:20", kind: "pause", text: "Iris Garcia hit the identity gate — the group reads Waiting on you until it is resolved", step: "Member fan-out" },
  ],
  data: [
    { step: "Parse typed input", dir: "read", field: "Names typed", value: "5", system: "kuali", ts: "1:49:40" },
    { step: "Parse typed input", dir: "read", field: "Preset merged", value: "July separations (3 fields)", system: "kuali", ts: "1:49:41" },
  ],
  receipt: {
    tone: "muted",
    headline: "Receipt — pending",
    note: "Rolls up when all 5 members are terminal: one line per person with the transaction number read back after submit.",
  },
  shots: [],
};

// ===========================================================================
// S6 — a read-only packet report (standalone OCR).
//
// A Run Row, never a group. It fans out lookups and finishes. There is NO
// approve flow at all: approval IS delegation, and nothing is delegated to,
// so the Review surface is read-only and the row can never be Waiting on you
// or Write parked. It authors no gate, so the contract sends no approve action
// and the button is structurally absent rather than merely hidden.
// ===========================================================================

const VERIFY_PEOPLE: { name: string; eid: string; page: number; state: DemoRecord["state"] }[] = [
  { name: "Liam Jones", eid: "10604411", page: 1, state: "ready" },
  { name: "Mona Alvarez", eid: "10611908", page: 2, state: "warn" },
  { name: "Noel Brooks", eid: "10618730", page: 3, state: "ready" },
];

const PL_VERIFY_IDS = VERIFY_PEOPLE.map((_, i) => `plv-m-${i}`);

function verifyRecord(i: number): DemoRecord {
  const p = VERIFY_PEOPLE[i];
  const incomplete = p.state === "warn";
  return {
    id: `vrec-${i}`,
    name: p.name,
    eid: p.eid,
    page: p.page,
    pageNote: `page ${p.page} of 3 · I-9 supporting packet`,
    state: p.state,
    fields: [
      { label: "Printed name", value: p.name, source: "paper", confidence: 0.96 },
      { label: "Employee ID", value: p.eid, source: "ucpath" },
      { label: "Document type", value: incomplete ? "List B — unreadable" : "List A — Passport", source: "paper", confidence: incomplete ? 0.38 : 0.91 },
      { label: "Department", value: "000482 · Facilities", source: "ucpath" },
    ],
    checks: [
      { label: "UCPath person", state: "ok", value: `1 active match · ${p.eid}` },
      { label: "Employment status", state: "ok", value: "Active" },
      { label: "Section 1 signed", state: "ok", value: "yes — on paper" },
      incomplete
        ? { label: "Document list", state: "warn", value: "unreadable on the scan — re-check or pull the paper" }
        : { label: "Document list", state: "ok", value: "List A — Passport" },
      { label: "Section 2 dated", state: incomplete ? "fail" : "ok", value: incomplete ? "no date found on the page" : "07/02/2026" },
    ],
    note: incomplete
      ? "Two completeness gaps on this page. This is a REPORT — there is nothing to approve and nothing downstream; re-check a line or pull the paper copy."
      : undefined,
    lookup: {
      trace: `pl-1409${pad(10 + i * 4, 2)}-v${pad(i, 2)}a`,
      status: "verifiedDone",
      note: `resolved ${p.eid} from the printed name`,
    },
  };
}

function plVerifyMember(i: number): DemoRowSpec {
  const p = VERIFY_PEOPLE[i];
  const startedAt = at(`14:09:${pad(10 + i * 4, 2)}`);
  const ts = fmtClockSec(plusSeconds(startedAt, 3));
  return {
    id: `plv-m-${i}`,
    rowType: "member",
    parentId: "pl-verify",
    containment: "member",
    workflowId: "person-lookup",
    title: p.name,
    eid: p.eid,
    runId4: `v${pad(i, 2)}a`,
    status: "verifiedDone",
    run: 1,
    version: 2,
    priority: "bulk",
    enqueuedAt: at("14:09:06"),
    startedAt,
    endedAt: plusSeconds(startedAt, 5),
    evidence: { receiptId: `rcpt-pl-v${pad(i, 2)}a`, confidence: "verified" },
    memberFact: `resolved ${p.eid}`,
    feedsInto: {
      label: `I9_Supporting_0724.pdf · record ${i + 1} (${p.name}) EID`,
      targetRunId: "ocr-verify",
    },
    outcome: { tone: "success", text: `Resolved ${p.name} → ${p.eid}` },
    steps: [{ label: "Searching", state: "done", system: "ucpath", durationSec: 5 }],
    lines: [{ ts, kind: "read", system: "ucpath", pills: [{ dir: "read", label: "EID", value: p.eid }], step: "Searching" }],
    data: [{ step: "Searching", dir: "read", field: "Employee ID", value: p.eid, system: "ucpath", ts }],
    receipt: {
      tone: "success",
      headline: "Verified done · person resolved",
      lines: [{ label: "Employee ID", value: p.eid, verified: true }],
    },
    shots: [],
  };
}

const plVerify: DemoRowSpec = {
  id: "pl-verify",
  rowType: "group",
  subjectKind: "person",
  workflowId: "person-lookup",
  title: "I9_Supporting_0724.pdf",
  groupNoun: "lookups",
  runId4: "b0d4",
  status: "verifiedDone",
  run: 6,
  version: 4,
  priority: "bulk",
  containment: "linked",
  linkedParentId: "ocr-verify",
  enqueuedAt: at("14:09:02"),
  startedAt: at("14:09:06"),
  endedAt: at("14:09:23"),
  evidence: { confidence: "verified" },
  memberIds: PL_VERIFY_IDS,
  feedsInto: { label: "I9_Supporting_0724.pdf · one EID per extracted record", targetRunId: "ocr-verify" },
  outcome: { tone: "success", text: "3 lookups done for the standalone OCR report — all resolved active" },
  steps: [
    { label: "Accept delegation", state: "done", durationSec: 1 },
    { label: "Member fan-out", state: "done", system: "ucpath", durationSec: 15 },
    { label: "Report back", state: "done", durationSec: 1 },
  ],
  lines: [{ ts: "2:09:06", kind: "event", text: "Delegated by the standalone OCR report — 3 names", step: "Accept delegation" }],
  data: [{ step: "Member fan-out", dir: "read", field: "People resolved", value: "3 of 3", system: "ucpath", ts: "2:09:23" }],
  receipt: {
    tone: "success",
    headline: "Verified done · 3 lookups answered",
    lines: [{ label: "Delegated by", value: "OCR · I9_Supporting_0724.pdf" }],
    members: VERIFY_PEOPLE.map((p) => ({ name: p.name, value: p.eid, verified: true })),
  },
  shots: [],
};

const ocrVerify: DemoRowSpec = {
  id: "ocr-verify",
  rowType: "run",
  subjectKind: "file",
  workflowId: "ocr",
  title: "I9_Supporting_0724.pdf",
  runId4: "9a15",
  status: "doneWarnings",
  run: 11,
  version: 4,
  enqueuedAt: at("14:07:44"),
  startedAt: at("14:07:52"),
  endedAt: at("14:09:31"),
  evidence: { receiptId: "rcpt-oc-9a15", confidence: "partial" },
  warnings: { count: 2, first: "page 2 — document list unreadable, Section 2 undated" },
  records: VERIFY_PEOPLE.map((_, i) => verifyRecord(i)),
  // no `reviewOf` and no `linkedParentId`: nobody delegated this run, so there
  // is nothing for an approval to release. The Review surface is read-only.
  linkedGroup: { ids: PL_VERIFY_IDS, noun: "lookups", panel: "Person Lookup", groupId: "pl-verify" },
  outcome: {
    tone: "warning",
    text: "Report complete — 3 people read, 2 completeness gaps on page 2. Nothing downstream: this run answers a question, it does not start work.",
  },
  steps: [
    { label: "Split pages", state: "done", system: "i9", durationSec: 6, keyLines: ["3 pages · 3 readable forms"] },
    { label: "Read forms", state: "done", system: "i9", durationSec: 61, keyLines: ["tier-1 model · 3/3 read", "page 2 document list below the confidence floor"] },
    { label: "Person lookup", state: "done", system: "ucpath", durationSec: 21, keyLines: ["3 delegated lookups · all active"] },
    { label: "Done", state: "done", durationSec: 1, keyLines: ["no approval phase — approval IS delegation, and nothing is delegated to"] },
  ],
  lines: [
    { ts: "2:07:52", kind: "event", system: "i9", text: "Split 3 pages · 3 carry a readable form", step: "Split pages" },
    { ts: "2:08:53", kind: "warn", system: "i9", text: "Page 2 — document list read at 0.38 confidence, and no Section 2 date found", step: "Read forms" },
    { ts: "2:09:06", kind: "event", system: "ucpath", text: "Delegated 3 person lookups — each is its own run in the Person Lookup panel", step: "Person lookup" },
    { ts: "2:09:31", kind: "ok", text: "Report complete — no approval step exists on a standalone run", duration: "1m 39s", step: "Done" },
  ],
  data: [
    { step: "Read forms", dir: "read", field: "Records read", value: "3", system: "i9", ts: "2:08:53" },
    { step: "Read forms", dir: "read", field: "Completeness gaps", value: "2 (page 2)", system: "i9", ts: "2:08:53" },
    { step: "Person lookup", dir: "read", field: "People resolved", value: "3 of 3", system: "ucpath", ts: "2:09:23" },
  ],
  receipt: {
    tone: "warning",
    headline: "Done with warnings · read-only report",
    lines: [
      { label: "Pages read", value: "3 of 3", verified: true },
      { label: "People resolved", value: "3 of 3", verified: true },
      { label: "Gaps", value: "page 2 — document list unreadable, Section 2 undated" },
      { label: "Written", value: "nothing — a standalone OCR run has no downstream" },
    ],
    note: "This receipt is the report. There is no approve step and no member fan-out: the answer is the record set above, and the two gaps are what you act on outside the tool.",
  },
  shots: [
    { label: "Page 1 · Jones", kind: "form" },
    { label: "Page 2 · Alvarez", kind: "form" },
  ],
};

// ===========================================================================
// Assembly + ordering helpers
// ===========================================================================

/**
 * The raw corpus — facts as the fixtures authored them, before projection.
 * Kept separate so a group can be rolled up from its members' statuses while
 * the projected map is still being built.
 */
const RAW_ROWS: DemoRowSpec[] = [
  [
    // needs you
    oathSummer,
    ocrSummer,
    sepMaria,
    sepRosa,
    sepList,
    // active
    i9Batch,
    ouPacket,
    wsBatch,
    plDaniel,
    krReports,
    sepNathan,
    plNathan,
    // queued
    wsPriya,
    // finished
    oathBatch,
    ocrSpring,
    ecPacket,
    ecSingle,
    obPacket,
    ocrOnbase,
    onbJordan,
    kpMarcus,
    obElena,
    cdSamuel,
    ecTomas,
    sepDana,
    plDana,
    ocrVerify,
    plSummer,
    plVerify,
    // members + linked children
    ...i9MemberIds.map((_, i) => i9Member(i)),
    ...oathMemberIds.map((_, i) => oathMember(i)),
    ...wsMemberIds.map((_, i) => wsMember(i)),
    ...ecPacketMemberIds.map((_, i) => ecPacketMember(i)),
    ecSingleMember,
    ...OU_SIGNER_IDS.map((_, i) => ouSigner(i)),
    ...SEP_LIST_IDS.map((_, i) => sepListMember(i)),
    ...PL_SUMMER_IDS.map((_, i) => plSummerMember(i)),
    ...PL_VERIFY_IDS.map((_, i) => plVerifyMember(i)),
  ],
].flat();

const RAW_BY_ID = new Map(RAW_ROWS.map((r) => [r.id, r]));

/** the projected wire surfaces — the ONLY thing any component reads */
export const DEMO_ROWS: Record<string, DemoRow> = Object.fromEntries(RAW_ROWS.map((spec) => [spec.id, projectRow(spec, RAW_BY_ID)]));

/** the status every surface renders — a group's is always the rollup */
export function effectiveStatus(row: DemoRow): ProposedStatus {
  if (row.rowType !== "group") return row.status;
  const ids = row.memberIds ?? [];
  const real = ids.map((id) => DEMO_ROWS[id]).filter((m) => m && m.containment !== "rejected");
  return rollupStatus(
    real.map((m) => m.status),
    ids.length - real.length,
    row.status,
  );
}

/**
 * The age of the decision this row is sitting on — DERIVED from the instant the
 * gate opened, never a stored string. This is the whole triage signal on a
 * collapsed row, and it is also the width of the timeline's waiting wedge, so
 * the two can never tell different stories.
 */
export function gateWaitSec(row: DemoRow, tick = 0): number | undefined {
  return row.gate ? secondsSince(row.gate.openedAt, tick) : undefined;
}

export function gateAge(row: DemoRow, tick = 0): string | undefined {
  const sec = gateWaitSec(row, tick);
  return sec === undefined ? undefined : fmtElapsed(sec);
}

// ---------------------------------------------------------------------------
// Bands — derived from the SAME effective status the counts use, so a row can
// never be counted in one place and rendered in another.
// ---------------------------------------------------------------------------

export type BandKey = "attention" | "active" | "queued" | "finished";

export const BAND_LABEL: Record<BandKey, string> = {
  attention: "Needs you",
  active: "Active",
  queued: "Queued",
  finished: "Finished today",
};

export function bandOf(row: DemoRow): BandKey {
  const s = effectiveStatus(row);
  if (s === "waiting" || s === "parked") return "attention";
  if (s === "running") return "active";
  if (s === "queued") return "queued";
  return "finished";
}

export function bandsFor(rows: DemoRow[]): { key: BandKey; label: string; rows: DemoRow[] }[] {
  return (["attention", "active", "queued", "finished"] as BandKey[]).map((key) => ({
    key,
    label: BAND_LABEL[key],
    rows: rows.filter((r) => bandOf(r) === key),
  }));
}

// ---------------------------------------------------------------------------
// Density ladder — member count is a continuous property, so scale is
// presentation, never a fourth row type.
//
// It stops at the scroll well ON PURPOSE. There used to be a fourth rung at 41+
// that swapped the member lines for a status matrix, and the operator read that
// matrix as a DIFFERENT KIND OF ROW: fifty coloured cells share no shape with
// the eighteen named lines directly above them, so the same object appeared to
// be two objects depending on how many people were in it. Scale is not a new
// concept, and a second visual language for "the same thing but more of it" is
// exactly what makes a product feel like it has more concepts than it has.
//
// Nothing is lost by that: the well is capped, so a 50-person group is the same
// height as an 18-person one; members are ordered attention-first, so the lines
// the operator has to act on are the ones already on screen; and `Open all N`
// still opens the drill-in, which is where a set that size is actually worked.
// ---------------------------------------------------------------------------

export type DensityRung = "inline" | "compact" | "well";

export function densityRung(memberCount: number): DensityRung {
  if (memberCount <= 3) return "inline";
  if (memberCount <= 12) return "compact";
  return "well";
}

export const DENSITY_RUNGS: { key: DensityRung; range: string; what: string; exampleId: string }[] = [
  {
    key: "inline",
    range: "1–3 members",
    what: "Full Member Rows, inline and always expanded. At this size the group IS its members — hiding them behind a chevron is pure friction.",
    exampleId: "ec-single",
  },
  {
    key: "compact",
    range: "4–12 members",
    what: "Compact person lines: the first four, then Show all N. Each line carries the one fact that distinguishes that person's outcome.",
    exampleId: "oath-batch",
  },
  {
    key: "well",
    range: "13+ members",
    what: "The same compact lines in a fixed-height scroll well, attention first, plus Open all N. The row is the same height at 13 people and at 50 — the count changes, the shape never does.",
    exampleId: "i9-batch",
  },
];

// ---------------------------------------------------------------------------
// Sort — applied WITHIN the attention bands, never across them
// ---------------------------------------------------------------------------

export type DemoSortKey = "attention" | "newest" | "oldest" | "longest";

export const DEMO_SORTS: { key: DemoSortKey; label: string; note: string }[] = [
  { key: "attention", label: "Attention first", note: "What needs you, then what broke, then everything else — the default." },
  { key: "newest", label: "Newest first", note: "Most recently started at the top." },
  { key: "oldest", label: "Oldest first", note: "The rows that have been sitting the longest." },
  { key: "longest", label: "Longest running", note: "Biggest elapsed or recorded duration first — where the time is going." },
];

const SORT_STATUS_RANK: Record<ProposedStatus, number> = {
  waiting: 0,
  failed: 1,
  parked: 2,
  running: 3,
  queued: 4,
  doneWarnings: 5,
  verifiedDone: 6,
  cancelled: 7,
};

/** how long this row has been working — recorded when it ended, live while it runs */
export function runSeconds(row: DemoRow, tick = 0): number {
  if (row.startedAt && row.endedAt) return secondsBetween(row.startedAt, row.endedAt);
  if (row.startedAt) return secondsSince(row.startedAt, tick);
  return 0;
}

/**
 * Sorting is a view over the SAME row set the bands and the counts use — it
 * reorders, it never filters, so no sort can change what a badge says.
 */
export function sortDemoRows(rows: DemoRow[], key: DemoSortKey, tick = 0): DemoRow[] {
  const born = (r: DemoRow) => Date.parse(r.startedAt ?? r.enqueuedAt);
  return [...rows].sort((a, b) => {
    switch (key) {
      case "newest":
        return born(b) - born(a);
      case "oldest":
        return born(a) - born(b);
      case "longest":
        return runSeconds(b, tick) - runSeconds(a, tick);
      case "attention":
        return SORT_STATUS_RANK[effectiveStatus(a)] - SORT_STATUS_RANK[effectiveStatus(b)] || born(b) - born(a);
    }
  });
}

/** a group auto-expands when a member is stuck on you or has broken */
export function groupNeedsExpanding(row: DemoRow): boolean {
  return (row.memberIds ?? []).some((id) => {
    const m = DEMO_ROWS[id];
    return m && m.containment !== "rejected" && (m.status === "waiting" || m.status === "failed");
  });
}

// ---------------------------------------------------------------------------
// Linked children — the parent shows a chip, never a copy
// ---------------------------------------------------------------------------

export interface LinkedGroupSummary {
  total: number;
  done: number;
  label: string;
  /** where the chip jumps: the collapsed Group Row if there is one, else the first child */
  targetId: string;
  panel: string;
  noun: string;
}

/**
 * The chip a parent shows for its `linked` children. A set of ONE is still a
 * set — it just reads as a state ("person lookup · running") instead of a
 * tally, because "1 person lookup · 0 done" tells you nothing you wanted.
 */
export function linkedGroupSummary(row: DemoRow): LinkedGroupSummary | null {
  const g = row.linkedGroup;
  if (!g || g.ids.length === 0) return null;
  const rows = g.ids.map((id) => DEMO_ROWS[id]).filter(Boolean);
  if (rows.length === 0) return null;
  const done = rows.filter((r) => r.status === "verifiedDone" || r.status === "doneWarnings").length;
  const label =
    rows.length === 1
      ? `${g.noun} · ${PROPOSED_STATUS[effectiveStatus(rows[0])].label.toLowerCase()}`
      : `${rows.length} ${g.noun} · ${done} done`;
  return { total: rows.length, done, label, targetId: g.groupId ?? g.ids[0], panel: g.panel, noun: g.noun };
}

// ---------------------------------------------------------------------------
// The shared member pipeline — the one legitimate group-as-aggregate strip
// ---------------------------------------------------------------------------

export interface SharedStepFill {
  label: string;
  done: number;
  total: number;
  /** a member is actively in this step right now */
  running: number;
  /** a member is stuck on you (or has broken) in this step */
  attention: number;
}

/**
 * When every member of a group runs the IDENTICAL step list — a typed list
 * (S5), not a packet — the group's strip is that shared pipeline with a
 * per-step fill bar. Returns null the moment two members disagree about their
 * steps, because an aggregate over different pipelines would be a fiction.
 */
export function sharedMemberPipeline(row: DemoRow): SharedStepFill[] | null {
  if (row.rowType !== "group") return null;
  const members = (row.memberIds ?? []).map((id) => DEMO_ROWS[id]).filter((m) => m && m.containment !== "rejected");
  if (members.length < 2) return null;
  const shape = members[0].steps.map((s) => s.label);
  if (shape.length === 0) return null;
  const identical = members.every((m) => m.steps.length === shape.length && m.steps.every((s, i) => s.label === shape[i]));
  if (!identical) return null;
  return shape.map((label, i) => ({
    label,
    done: members.filter((m) => m.steps[i].state === "done").length,
    running: members.filter((m) => m.steps[i].state === "current").length,
    attention: members.filter((m) => m.steps[i].state === "waiting" || m.steps[i].state === "failed").length,
    total: members.length,
  }));
}

// ---------------------------------------------------------------------------
// Attempt lineage — a prior attempt's trace id is DERIVED, never stored
// ---------------------------------------------------------------------------

export function attemptTrace(row: DemoRow, attempt: DemoAttempt): string {
  return `${row.workflow.code}-${traceClock(attempt.startedAt)}-${attempt.runId4}`;
}

export function attemptDuration(attempt: DemoAttempt): string | undefined {
  return attempt.endedAt ? fmtElapsed(secondsBetween(attempt.startedAt, attempt.endedAt)) : undefined;
}

export const ATTENTION_STATUSES: ProposedStatus[] = ["failed", "waiting", "doneWarnings", "parked"];

const MEMBER_ATTENTION_RANK: Record<ProposedStatus, number> = {
  failed: 0,
  waiting: 1,
  doneWarnings: 2,
  parked: 2,
  running: 3,
  queued: 4,
  cancelled: 5,
  verifiedDone: 6,
};

/** attention-first member ordering for a group (rejected pages sink just above done) */
export function orderedMemberIds(groupId: string): string[] {
  const group = DEMO_ROWS[groupId];
  if (!group?.memberIds) return [];
  return [...group.memberIds].sort((a, b) => {
    const ra = DEMO_ROWS[a];
    const rb = DEMO_ROWS[b];
    const rankA = ra.containment === "rejected" ? 5 : MEMBER_ATTENTION_RANK[ra.status];
    const rankB = rb.containment === "rejected" ? 5 : MEMBER_ATTENTION_RANK[rb.status];
    return rankA - rankB || a.localeCompare(b);
  });
}

export function memberAttentionIds(groupId: string): string[] {
  return orderedMemberIds(groupId).filter((id) => {
    const r = DEMO_ROWS[id];
    return r.containment !== "rejected" && ATTENTION_STATUSES.includes(r.status);
  });
}

export interface GroupCounts {
  done: number;
  running: number;
  queued: number;
  failed: number;
  warnings: number;
  waiting: number;
  parked: number;
  /** never folded into done — a rejected page is work that never existed */
  rejected: number;
}

export function groupCounts(groupId: string): GroupCounts {
  const out: GroupCounts = { done: 0, running: 0, queued: 0, failed: 0, warnings: 0, waiting: 0, parked: 0, rejected: 0 };
  for (const id of DEMO_ROWS[groupId]?.memberIds ?? []) {
    const r = DEMO_ROWS[id];
    if (r.containment === "rejected") out.rejected += 1;
    else if (r.status === "verifiedDone") out.done += 1;
    else if (r.status === "doneWarnings") out.warnings += 1;
    else if (r.status === "running") out.running += 1;
    else if (r.status === "queued") out.queued += 1;
    else if (r.status === "waiting") out.waiting += 1;
    else if (r.status === "parked") out.parked += 1;
    else if (r.status === "failed") out.failed += 1;
  }
  return out;
}


