/**
 * DEV-ONLY — the rebuild demo's world model (`?view=rebuild-demo`).
 *
 * One typed source of truth: every queue row — the 3 ratified row types
 * (run / group / member) across all 8 ratified statuses — carries its OWN
 * pipeline, log stream, data ledger, gate, receipt, and screenshot set, so the
 * demo log panel derives entirely per-row. Deterministic content only (stable
 * screenshots, no randomness).
 */

import type { ProposedStatus } from "./demo-status";

export type SystemKey = "kuali" | "ucpath" | "kronos" | "crm" | "servicenow" | "onbase" | "i9";

export const SYSTEM_ACCENT: Record<SystemKey, string> = {
  kuali: "bg-log-violet/15 text-log-violet",
  ucpath: "bg-log-cyan/15 text-log-cyan",
  kronos: "bg-log-teal/15 text-log-teal",
  crm: "bg-log-slate/15 text-log-slate",
  servicenow: "bg-log-violet/15 text-log-violet",
  onbase: "bg-log-teal/15 text-log-teal",
  i9: "bg-log-cyan/15 text-log-cyan",
};

export const WATERFALL_ACCENT: Record<SystemKey, string> = {
  kuali: "bg-log-violet/70",
  ucpath: "bg-log-cyan/70",
  kronos: "bg-log-teal/70",
  crm: "bg-log-slate/70",
  servicenow: "bg-log-violet/50",
  onbase: "bg-log-teal/50",
  i9: "bg-log-cyan/50",
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

/**
 * The two typed resolutions of a Write-parked run. Parked means the outcome of a
 * write is genuinely UNKNOWN — never "held before submitting" (that is a gate,
 * i.e. Waiting on you). There are exactly two ways out, and both are the
 * operator TELLING us what they saw in the system of record.
 */
export type ParkResolutionKey = "confirmed-present" | "confirmed-absent";

export interface DemoParkResolution {
  key: ParkResolutionKey;
  label: string;
  detail: string;
}

export interface DemoGate {
  kind: "identity" | "parked" | "approval";
  title: string;
  openedAt: string;
  waiting: string;
  candidates?: { heading: string; name: string; sub: string }[];
  staged?: { field: string; value: string; system: SystemKey; unconfirmed?: boolean }[];
  /** parked only — the two typed resolutions; renders instead of `actions` */
  resolutions?: DemoParkResolution[];
  /** first action renders primary */
  actions: string[];
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

export interface DemoOutcome {
  tone: "warning" | "violet" | "info" | "success" | "destructive" | "muted";
  text: string;
  action?: string;
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
  /** "signers" / "contacts" — what the linked runs are */
  noun: string;
  /** the Workflow Panel entry the chip jumps to */
  panel: string;
}

export interface DemoRow {
  id: string;
  rowType: "run" | "group" | "member";
  /** what the row is ABOUT — drives title/subtitle and the Run Row variant name */
  subjectKind?: "person" | "file" | "catalog";
  wfLabel: string;
  title: string;
  eid?: string;
  trace: string;
  status: ProposedStatus;
  time: string;
  run: number;
  /** live rows tick from this offset (seconds) in the shell */
  elapsedSec?: number;
  duration?: string;
  facts?: DemoFact[];
  warnings?: { count: number; first: string };
  attempt?: { n: number; prior: string };
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

const sepMaria: DemoRow = {
  id: "sep-maria",
  rowType: "run",
  wfLabel: "Separations",
  title: "Maria Lopez-Garcia",
  trace: "se-140211-9f3a",
  status: "waiting",
  time: "2:02 PM",
  run: 4,
  outcome: { tone: "warning", text: "Paused on identity approval — 18m in gate · nothing written yet", action: "Review" },
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
    openedAt: "2:03 PM",
    waiting: "18m",
    candidates: [
      { heading: "On the input record", name: "Maria Lopez", sub: "no EID · Kuali doc 4-VMPHRW" },
      { heading: "UCPath name match (proposed)", name: "M. Lopez-Garcia", sub: "10583942 · Dept 000371 · Blank Ast 3" },
    ],
    actions: ["Use 10583942", "Enter EID…", "Dismiss"],
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
const sepRosa: DemoRow = {
  id: "sep-rosa",
  rowType: "run",
  wfLabel: "Separations",
  title: "Rosa Delgado",
  eid: "10577201",
  trace: "se-134802-c2d7",
  status: "parked",
  time: "1:48 PM",
  run: 3,
  outcome: {
    tone: "violet",
    text: "Write outcome unknown — submit sent, confirmation never came back. Do not re-run until you resolve it.",
    action: "Resolve",
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
    openedAt: "1:52 PM",
    waiting: "32m",
    staged: [
      { field: "Separation date", value: "07/18/2026", system: "ucpath", unconfirmed: true },
      { field: "Action", value: "Voluntary termination", system: "ucpath", unconfirmed: true },
    ],
    resolutions: [
      {
        key: "confirmed-present",
        label: "Confirmed present",
        detail: "You found the termination in UCPath. The run closes as Verified done and records the transaction you read.",
      },
      {
        key: "confirmed-absent",
        label: "Confirmed absent",
        detail: "You found nothing in UCPath. The run closes as Failed and becomes safely retryable — the retry cannot duplicate.",
      },
    ],
    actions: ["Open the last screenshot", "Open Rosa in UCPath"],
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

const plDaniel: DemoRow = {
  id: "pl-daniel",
  rowType: "run",
  wfLabel: "Person Lookup",
  title: "Daniel Okafor",
  eid: "10488213",
  trace: "pl-141904-72e1",
  status: "running",
  time: "2:19 PM",
  run: 12,
  elapsedSec: 14,
  liveText: "Cross-verification — matching CRM record by start date",
  outcome: { tone: "info", text: "Running — cross-verification · matching CRM record by start date" },
  steps: [
    { label: "Searching", state: "done", system: "ucpath", durationSec: 6, keyLines: ["1 active match · 10488213"] },
    { label: "Cross-verification", state: "current", system: "crm" },
    { label: "Active status", state: "pending", system: "ucpath" },
    { label: "CRM dates", state: "pending", system: "crm" },
  ],
  lines: [
    { ts: "2:19:04", kind: "search", system: "ucpath", text: "Person search: “Daniel Okafor” — 1 active match", step: "Searching" },
    { ts: "2:19:08", kind: "read", system: "ucpath", pills: [{ dir: "read", label: "EID", value: "10488213" }, { dir: "read", label: "dept", value: "000512" }], step: "Searching" },
    { ts: "2:19:10", kind: "ok", text: "Searching complete", duration: "6s", step: "Searching" },
    { ts: "2:19:11", kind: "nav", system: "crm", text: "CRM onboarding record open", step: "Cross-verification" },
  ],
  data: [
    { step: "Searching", dir: "read", field: "EID", value: "10488213", system: "ucpath", ts: "2:19:08" },
    { step: "Searching", dir: "read", field: "Department", value: "000512", system: "ucpath", ts: "2:19:08" },
  ],
  receipt: { tone: "muted", headline: "Receipt — pending", note: "Person Lookup is read-only — its receipt records what was looked up and where, never a write." },
  shots: [{ label: "UCPath search", kind: "step" }],
};

/** canned live-sim lines the shell appends on a timer for the running row */
export const LIVE_SEQUENCE: DemoLine[] = [
  { ts: "2:19:18", kind: "read", system: "crm", pills: [{ dir: "read", label: "start date", value: "07/01/2026" }], step: "Cross-verification" },
  { ts: "2:19:21", kind: "ok", text: "CRM record matched by start date", step: "Cross-verification" },
  { ts: "2:19:23", kind: "nav", system: "ucpath", text: "Checking HR status — active flag", step: "Active status" },
  { ts: "2:19:26", kind: "read", system: "ucpath", pills: [{ dir: "read", label: "HR status", value: "Active" }], step: "Active status" },
];

const oathMemberIds = Array.from({ length: 12 }, (_, i) => `oath-m-${i}`);
const i9MemberIds = Array.from({ length: 50 }, (_, i) => `i9-m-${i}`);

const i9Batch: DemoRow = {
  id: "i9-batch",
  rowType: "group",
  wfLabel: "I-9 Check",
  title: "I9_Quarterly_Retention.pdf",
  trace: "ic-134001-77aa",
  status: "running",
  time: "1:40 PM",
  run: 8,
  elapsedSec: 1325,
  ocrPhase: "UCPath search · roster re-match — 44/50 people processed",
  memberIds: i9MemberIds,
  outcome: { tone: "info", text: "Fan-out running — 44/50 people processed · 4 need attention", action: "Start review" },
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

const oathBatch: DemoRow = {
  id: "oath-batch",
  rowType: "group",
  subjectKind: "file",
  wfLabel: "Oath Signature",
  title: "Oath_Packet_Spring.pdf",
  trace: "os-110501-c2f0",
  // authored as a fallback only — with members present the badge comes from the
  // shared rollup (one failed member outranks eleven verified ones)
  status: "failed",
  time: "11:05 AM",
  run: 4,
  duration: "18m 40s",
  warnings: { count: 1, first: "1 signer failed — signature field never rendered" },
  memberIds: oathMemberIds,
  reviewRunId: "ocr-spring",
  outcome: { tone: "destructive", text: "11/12 signed · Grace Egan failed — signature field never rendered", action: "Open failure" },
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

const onbJordan: DemoRow = {
  id: "onb-jordan",
  rowType: "run",
  wfLabel: "Onboarding",
  title: "Jordan Whitfield",
  eid: "10633092",
  trace: "on-114203-4f9b",
  status: "verifiedDone",
  time: "11:42 AM",
  run: 2,
  duration: "6m 41s",
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

const kpMarcus: DemoRow = {
  id: "kp-marcus",
  rowType: "run",
  wfLabel: "Kronos Pay Rule",
  title: "Marcus Bell",
  eid: "10312007",
  trace: "kp-101502-d6a0",
  status: "verifiedDone",
  time: "10:15 AM",
  run: 6,
  duration: "1m 12s",
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

const obElena: DemoRow = {
  id: "ob-elena",
  rowType: "run",
  wfLabel: "OnBase",
  title: "Elena Vasquez",
  eid: "10590114",
  trace: "ob-095204-77b2",
  status: "doneWarnings",
  time: "9:52 AM",
  run: 3,
  duration: "2m 55s",
  warnings: { count: 1, first: "keyset autofill fell back — verify keywords" },
  facts: [
    { label: "doc", value: "I-9 Supporting" },
    { label: "page", value: "4" },
  ],
  outcome: { tone: "warning", text: "Imported with 1 warning — keyset autofill fell back, verify keywords", action: "Open import" },
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

const cdSamuel: DemoRow = {
  id: "cd-samuel",
  rowType: "run",
  wfLabel: "CRM Doc Download",
  title: "Samuel Ortiz",
  trace: "cd-131202-5e19",
  status: "failed",
  time: "1:12 PM",
  run: 9,
  duration: "48s",
  attempt: { n: 2, prior: "Attempt 1 failed 12:58 PM — timeout" },
  failShots: 3,
  error: "CRM search returned no record for samuel.ortiz@ucsd.edu — download step never reached",
  outcome: { tone: "destructive", text: "Failed — CRM search returned no record for samuel.ortiz@ucsd.edu", action: "Retry" },
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

const wsPriya: DemoRow = {
  id: "ws-priya",
  rowType: "run",
  wfLabel: "Work-Study",
  title: "Priya Natarajan",
  eid: "10601188",
  trace: "ws-142401-e8c3",
  status: "queued",
  time: "2:24 PM",
  run: 5,
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

const ecTomas: DemoRow = {
  id: "ec-tomas",
  rowType: "run",
  wfLabel: "Emergency Contact",
  title: "Tomás Rivera",
  eid: "10443321",
  trace: "ec-091500-4a02",
  status: "cancelled",
  time: "9:15 AM",
  run: 1,
  duration: "22s",
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

function i9Member(i: number): DemoRow {
  const name = i === I9_REJECTED_INDEX ? "Page 31" : `${FIRST[i % 25]} ${LAST[i % 10]}`;
  const eid = `105${pad(31000 + i * 137, 5)}`;
  const status: ProposedStatus = i === I9_REJECTED_INDEX ? "failed" : (I9_SPECIAL[i] ?? "verifiedDone");
  const ts = `1:${pad(45 + (i % 14), 2)} PM`;
  const trace = `ic-134001-m${pad(i, 2)}`;
  const base: Omit<DemoRow, "outcome" | "steps" | "lines" | "receipt"> = {
    id: `i9-m-${i}`,
    rowType: "member",
    parentId: "i9-batch",
    containment: i === I9_REJECTED_INDEX ? "rejected" : "member",
    wfLabel: "I-9 Check",
    title: name,
    eid,
    trace,
    status,
    time: ts,
    run: 1,
    data: [],
    shots: [],
    checkedByDefault: status === "verifiedDone" && i < 12,
  };
  if (i === I9_REJECTED_INDEX) {
    return {
      ...base,
      displayOnly: true,
      memberFact: "no searchable name",
      duration: "—",
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
        duration: "41s",
        error: `UCPath person search found no match for “${name}” or EID ${eid}`,
        outcome: { tone: "destructive", text: `No UCPath match for “${name}” — roster row left unmatched`, action: "Retry" },
        steps: [
          { label: "Person match", state: "failed", system: "ucpath", durationSec: 41, keyLines: [`“${name}” → 0 rows`, `EID ${eid} → 0 rows`] },
          { label: "Person lookup", state: "pending", system: "ucpath" },
          { label: "Roster match", state: "pending", system: "i9" },
        ],
        lines: [
          { ts: "2:41:07", kind: "search", system: "ucpath", text: `Person search: “${name}” → no rows · retried by EID → no rows`, card: "failure", step: "Person match" },
        ],
        failCard: { title: "Person search found no match", meta: `Searched “${name}” + EID ${eid} in UCPath — 0 results either way.` },
        receipt: { tone: "destructive", headline: "No receipt — person not found", lines: [{ label: "Failed at", value: "Person match" }, { label: "Roster row", value: `${i + 1} — left unmatched` }], note: "Check the roster spelling; retry replays this one person only." },
        shots: [{ label: "Search results (0)", kind: "error" }],
      };
    case "waiting":
      return {
        ...base,
        memberFact: "2 name candidates",
        outcome: { tone: "warning", text: "Two active UCPath people match this name — pick one", action: "Review" },
        steps: [
          { label: "Person match", state: "waiting", system: "ucpath", keyLines: ["2 active candidates share this name"] },
          { label: "Person lookup", state: "pending", system: "ucpath" },
          { label: "Roster match", state: "pending", system: "i9" },
        ],
        lines: [
          { ts: "1:58:12", kind: "warn", system: "ucpath", text: "2 active people named on this form — pausing for a decision", card: "gate", step: "Person match" },
        ],
        gate: {
          kind: "identity",
          title: "Waiting on you — which person is on the form?",
          openedAt: "1:58 PM",
          waiting: "26m",
          candidates: [
            { heading: "Candidate A", name: `${name}`, sub: `10531548 · Dept 000371 · hired 03/12/2024` },
            { heading: "Candidate B", name: `${name} (2nd match)`, sub: `10577940 · Dept 000512 · hired 09/02/2019` },
          ],
          actions: ["Use 10531548", "Use 10577940", "Skip person"],
          note: "The I-9 hire date on the form (03/12/2024) matches candidate A within tolerance — shown first.",
        },
        receipt: { tone: "muted", headline: "Receipt — pending", note: "Blocked on the identity decision; nothing recorded yet." },
        shots: [{ label: "Both candidates", kind: "step" }],
      };
    case "doneWarnings":
      return {
        ...base,
        memberFact: "S2 missing — flag",
        duration: `${34 + (i % 5) * 7}s`,
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
        elapsedSec: 34,
        memberFact: "person-lookup…",
        liveText: "Person lookup — cross-verifying hire date",
        outcome: { tone: "info", text: "Running — person lookup, cross-verifying hire date" },
        steps: [
          { label: "Person match", state: "done", system: "ucpath", durationSec: 9 },
          { label: "Person lookup", state: "current", system: "ucpath" },
          { label: "Roster match", state: "pending", system: "i9" },
        ],
        lines: [
          { ts: "2:23:44", kind: "ok", system: "ucpath", text: "Person matched — 1 active row", step: "Person match" },
          { ts: "2:23:51", kind: "nav", system: "ucpath", text: "Opening person profile for hire-date check", step: "Person lookup" },
        ],
        receipt: { tone: "muted", headline: "Receipt — pending", note: "Still running." },
        shots: [],
      };
    case "queued":
      return {
        ...base,
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
        duration: `${34 + (i % 5) * 7}s`,
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

function oathMember(i: number): DemoRow {
  const name = `${FIRST[(i * 3) % 25]} ${LAST[(i * 7) % 10]}`;
  const eid = `105${pad(31000 + i * 91, 5)}`;
  const failed = i === 2;
  const signTime = `11:${pad(8 + i, 2)} AM`;
  return {
    id: `oath-m-${i}`,
    rowType: "member",
    parentId: "oath-batch",
    containment: "member",
    recordId: `spring-rec-${i}`,
    wfLabel: "Oath Signature",
    title: name,
    eid,
    trace: `os-110501-m${pad(i, 2)}`,
    status: failed ? "failed" : "verifiedDone",
    time: signTime,
    run: 1,
    duration: failed ? "1m 2s" : `${35 + (i % 6)}s`,
    memberFact: failed ? "signature field never rendered" : `signed ${signTime}`,
    error: failed ? "Signature field never rendered after 3 attempts" : undefined,
    outcome: failed
      ? { tone: "destructive", text: "Signature field never rendered after 3 attempts", action: "Retry" }
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
      ? [{ ts: "11:23:44", kind: "error", system: "ucpath", text: "Signature field never rendered (3 attempts, fresh page each)", card: "failure", step: "Sign oath" }]
      : [
          { ts: signTime.replace(" AM", ":21"), kind: "ok", system: "crm", text: "CRM onboarding record verified", step: "CRM verify" },
          { ts: signTime.replace(" AM", ":40"), kind: "write", system: "ucpath", pills: [{ dir: "write", label: "oath signed", value: signTime }], step: "Sign oath" },
        ],
    data: failed
      ? []
      : [{ step: "Sign oath", dir: "write", field: "Oath signature", value: signTime, system: "ucpath", ts: signTime }],
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

const oathSummer: DemoRow = {
  id: "oath-summer",
  rowType: "group",
  subjectKind: "file",
  wfLabel: "Oath Signature",
  title: "Oath_Packet_Summer.pdf",
  trace: "os-142012-b410",
  status: "waiting",
  time: "2:20 PM",
  run: 5,
  elapsedSec: 640,
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
    action: "Review people",
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
    openedAt: "2:22 PM",
    waiting: "10m",
    note: "Approve straight from here if the packet reads clean; open the review to look at each person beside their page. Approving fans out one signer task per approved person — that is when member rows appear. Diego Diaz is blocked (inactive) and is excluded from the count.",
    actions: ["Approve 5 of 6", "Open review", "Discard packet"],
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

const ocrSummer: DemoRow = {
  id: "ocr-summer",
  rowType: "run",
  subjectKind: "file",
  wfLabel: "OCR",
  title: "Oath_Packet_Summer.pdf",
  trace: "oc-142012-d771",
  status: "waiting",
  time: "2:20 PM",
  run: 5,
  elapsedSec: 640,
  containment: "linked",
  linkedParentId: "oath-summer",
  reviewOf: "oath-summer",
  records: SUMMER_RECORDS,
  outcome: {
    tone: "warning",
    text: "6 people extracted — 0 reviewed · 1 blocked · 2 flagged. Approve to release the signers.",
    action: "Start review",
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
    openedAt: "2:23 PM",
    waiting: "10m",
    note: "Each person is shown beside the page they were read from. Approve per person; the packet fans out only what you approved.",
    actions: ["Approve 5 of 6", "Reupload packet", "Discard"],
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

const ocrSpring: DemoRow = {
  id: "ocr-spring",
  rowType: "run",
  subjectKind: "file",
  wfLabel: "OCR",
  title: "Oath_Packet_Spring.pdf",
  trace: "oc-110501-a19c",
  status: "verifiedDone",
  time: "11:05 AM",
  run: 4,
  duration: "6m 31s",
  containment: "linked",
  linkedParentId: "oath-batch",
  reviewOf: "oath-batch",
  records: Array.from({ length: 12 }, (_, i) => springRecord(i)),
  outcome: { tone: "success", text: "12 of 12 read and approved at 11:12 AM — the packet fanned out 12 signers", action: "Open packet" },
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

const OU_SIGNERS: { name: string; eid: string; status: ProposedStatus; fact: string; time: string }[] = [
  { name: "Nadia Osei", eid: "10612004", status: "verifiedDone", fact: "signed 10:19 AM", time: "10:19 AM" },
  { name: "Ravi Chandran", eid: "10598337", status: "verifiedDone", fact: "signed 10:21 AM", time: "10:21 AM" },
  { name: "Lena Hoffmann", eid: "10604412", status: "verifiedDone", fact: "signed 10:24 AM", time: "10:24 AM" },
  { name: "Tobias Frey", eid: "10587760", status: "running", fact: "signing…", time: "10:26 AM" },
  { name: "Priya Anand", eid: "10620118", status: "queued", fact: "—", time: "10:26 AM" },
  { name: "Marcus Boone", eid: "10577903", status: "queued", fact: "—", time: "10:26 AM" },
];

function ouSigner(i: number): DemoRow {
  const s = OU_SIGNERS[i];
  const done = s.status === "verifiedDone";
  const running = s.status === "running";
  return {
    id: `ou-s-${i}`,
    rowType: "run",
    wfLabel: "Oath Signature",
    title: s.name,
    eid: s.eid,
    trace: `os-1012${pad(30 + i * 2, 2)}-s${pad(i, 2)}`,
    status: s.status,
    time: s.time,
    run: 1,
    // linked, not member: this row is the signer's own run and lives here, in
    // the Oath Signature panel, exactly once.
    containment: "linked",
    linkedParentId: "ou-packet",
    duration: done ? `${28 + i * 3}s` : undefined,
    elapsedSec: running ? 47 : undefined,
    queueNote: s.status === "queued" ? "in queue · behind the running signer" : undefined,
    liveText: running ? "Signing oath — UCPath signature canvas" : undefined,
    outcome: done
      ? { tone: "success", text: `Oath signed ${s.time} — CRM verified` }
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
          { ts: s.time.replace(" AM", ":11"), kind: "ok", system: "crm", text: "CRM onboarding record verified", step: "CRM verify" },
          { ts: s.time.replace(" AM", ":38"), kind: "write", system: "ucpath", pills: [{ dir: "write", label: "oath signed", value: s.time }], step: "Sign oath" },
        ]
      : running
        ? [{ ts: "10:26:04", kind: "nav", system: "ucpath", text: "Signature canvas open", step: "Sign oath" }]
        : [{ ts: "10:26:10", kind: "event", text: "Enqueued by Signed_Oaths_0724.pdf — waiting for a worker", step: "Queued" }],
    data: done ? [{ step: "Sign oath", dir: "write", field: "Oath signature", value: s.time, system: "ucpath", ts: s.time }] : [],
    receipt: done
      ? {
          tone: "success",
          headline: "Verified done · oath signed",
          lines: [
            { label: "Signed", value: s.time, verified: true },
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

const ouPacket: DemoRow = {
  id: "ou-packet",
  rowType: "run",
  subjectKind: "file",
  wfLabel: "Oath Upload",
  title: "Signed_Oaths_0724.pdf",
  trace: "ou-101204-3b8e",
  status: "running",
  time: "10:12 AM",
  run: 7,
  elapsedSec: 884,
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
    action: "Open signers",
  },
  steps: [
    { label: "OCR prep", state: "done", system: "i9", durationSec: 96, keyLines: ["6 signed oaths recognised"] },
    { label: "Your review", state: "done", durationSec: 141, keyLines: ["approved 6/6 at 10:15 AM"] },
    { label: "Wait signatures", state: "current", system: "ucpath", keyLines: ["3 of 6 signers done", "each signer is its own run in the Oath Signature panel"] },
    { label: "File ticket", state: "pending", system: "servicenow" },
  ],
  lines: [
    { ts: "10:12:04", kind: "event", text: "Upload — Signed_Oaths_0724.pdf · 6 pages", step: "OCR prep" },
    { ts: "10:13:40", kind: "ok", system: "i9", text: "6 signed oaths recognised · all 6 matched to UCPath records", step: "OCR prep" },
    { ts: "10:15:01", kind: "event", text: "You approved 6 of 6", step: "Your review" },
    {
      ts: "10:15:04",
      kind: "event",
      text: "Released 6 signer runs into the Oath Signature panel — they are linked, not copied: this row waits on them and shows a chip",
      step: "Wait signatures",
    },
    { ts: "10:24:12", kind: "ok", system: "ucpath", text: "3 of 6 signers done — waiting on the remaining 3", step: "Wait signatures" },
  ],
  data: [
    { step: "OCR prep", dir: "read", field: "Signed oaths found", value: "6", system: "i9", ts: "10:13:40" },
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

const krReports: DemoRow = {
  id: "kr-reports",
  rowType: "run",
  subjectKind: "catalog",
  wfLabel: "Kronos Reports",
  title: "Pay-period exception reports",
  trace: "kr-140455-6c22",
  status: "running",
  time: "2:04 PM",
  run: 12,
  elapsedSec: 386,
  liveText: "Downloading report 4 of 7 — Missed Punch Detail",
  facts: [
    { label: "selection", value: "7 reports" },
    { label: "period", value: "07/06 – 07/19" },
  ],
  outcome: { tone: "info", text: "Running — 3 of 7 reports downloaded · 4 workers", action: "Open folder" },
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
// Roster Group Row at the 13–40 rung — too many for a readable inline list,
// too few for a matrix. A scroll well keeps the row a fixed height without
// pretending 18 people are 50.
// ===========================================================================

const wsMemberIds = Array.from({ length: 18 }, (_, i) => `ws-m-${i}`);

const WS_SPECIAL: Record<number, ProposedStatus> = { 5: "doneWarnings", 12: "running", 16: "queued", 17: "queued" };

function wsMember(i: number): DemoRow {
  const name = `${FIRST[(i * 5) % 25]} ${LAST[(i * 3) % 10]}`;
  const eid = `106${pad(12000 + i * 211, 5)}`;
  const status: ProposedStatus = WS_SPECIAL[i] ?? "verifiedDone";
  const ts = `9:${pad(12 + i, 2)} AM`;
  const base: Omit<DemoRow, "outcome" | "steps" | "lines" | "receipt"> = {
    id: `ws-m-${i}`,
    rowType: "member",
    parentId: "ws-batch",
    containment: "member",
    wfLabel: "Work-Study",
    title: name,
    eid,
    trace: `ws-091104-w${pad(i, 2)}`,
    status,
    time: ts,
    run: 1,
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
      elapsedSec: 51,
      memberFact: "filling transaction…",
      liveText: "UCPath transaction — effective 07/01/2026",
      outcome: { tone: "info", text: "Running — filling the work-study transaction" },
      steps: [
        { label: "UCPath auth", state: "done", system: "ucpath", durationSec: 8 },
        { label: "Transaction", state: "current", system: "ucpath" },
      ],
      lines: [{ ts: "9:24:11", kind: "nav", system: "ucpath", text: "Work-study transaction template open", step: "Transaction" }],
      receipt: { tone: "muted", headline: "Receipt — pending", note: "Still running." },
    };
  }
  if (status === "queued") {
    return {
      ...base,
      memberFact: "—",
      queueNote: `in queue · position ${i - 15}`,
      outcome: { tone: "muted", text: "Queued behind the running person" },
      steps: [
        { label: "UCPath auth", state: "pending", system: "ucpath" },
        { label: "Transaction", state: "pending", system: "ucpath" },
      ],
      lines: [{ ts: "9:11:04", kind: "event", text: "Fanned out from the typed roster", step: "Queued" }],
      receipt: { tone: "muted", headline: "Receipt — pending", note: "Nothing has run yet." },
    };
  }
  if (status === "doneWarnings") {
    return {
      ...base,
      duration: "38s",
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
    duration: `${24 + (i % 7)}s`,
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

const wsBatch: DemoRow = {
  id: "ws-batch",
  rowType: "group",
  subjectKind: "person",
  wfLabel: "Work-Study",
  title: "Work-study awards — 18 people",
  trace: "ws-091104-2d5f",
  status: "running",
  time: "9:11 AM",
  run: 3,
  elapsedSec: 1140,
  memberIds: wsMemberIds,
  ocrPhase: "16 of 18 processed — 1 running, 2 queued",
  outcome: { tone: "info", text: "Fan-out running — 16 of 18 processed · 1 flagged", action: "Open all 18" },
  steps: [
    { label: "Parse input", state: "done", durationSec: 3, keyLines: ["18 typed EIDs · all resolved"] },
    { label: "Member fan-out", state: "current", system: "ucpath" },
    { label: "Rollup", state: "pending" },
  ],
  lines: [
    { ts: "9:11:04", kind: "event", text: "18 people typed into the input panel — one group, not 18 loose rows", step: "Parse input" },
    { ts: "9:11:07", kind: "event", text: "Fanned out 18 member tasks", step: "Member fan-out" },
    { ts: "9:22:41", kind: "warn", text: "1 member moved an effective date to the pay-period start", step: "Member fan-out" },
  ],
  data: [{ step: "Parse input", dir: "read", field: "People typed", value: "18", system: "ucpath", ts: "9:11:04" }],
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

function ecPacketMember(i: number): DemoRow {
  const rejected = i === EC_REJECTED_INDEX;
  const name = rejected ? "Page 7" : `${FIRST[(i * 9) % 25]} ${LAST[(i * 4) % 10]}`;
  const eid = `104${pad(41000 + i * 173, 5)}`;
  const ts = `3:${pad(31 + i, 2)} PM`;
  if (rejected) {
    return {
      id: `ecp-m-${i}`,
      rowType: "member",
      parentId: "ec-packet",
      containment: "rejected",
      displayOnly: true,
      wfLabel: "Emergency Contact",
      title: name,
      trace: `ec-152800-r${pad(i, 2)}`,
      status: "failed",
      time: "3:29 PM",
      run: 1,
      duration: "—",
      memberFact: "no contact block on the page",
      outcome: {
        tone: "muted",
        text: "Rejected page — the form has no emergency-contact block. Display-only: no task exists, delete is the only action.",
      },
      steps: [{ label: "OCR extraction", state: "failed", system: "i9", keyLines: ["page 7: no contact fields detected"] }],
      lines: [{ ts: "3:29:44", kind: "warn", system: "i9", text: "Page 7 — no emergency-contact block; the page cannot become work", step: "OCR extraction" }],
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
    wfLabel: "Emergency Contact",
    title: name,
    eid,
    trace: `ec-152800-m${pad(i, 2)}`,
    status: "verifiedDone",
    time: ts,
    run: 1,
    duration: `${29 + i * 4}s`,
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

const ecPacket: DemoRow = {
  id: "ec-packet",
  rowType: "group",
  subjectKind: "file",
  wfLabel: "Emergency Contact",
  title: "EC_Forms_0722.pdf",
  trace: "ec-152800-9b31",
  status: "doneWarnings",
  time: "3:28 PM",
  run: 2,
  duration: "4m 06s",
  memberIds: ecPacketMemberIds,
  warnings: { count: 1, first: "1 page could not be turned into work" },
  outcome: {
    tone: "warning",
    text: "5 done · 1 rejected — the packet stays at Done with warnings until the rejected page is deleted or acknowledged.",
    action: "Open rejected page",
  },
  steps: [
    { label: "OCR extraction", state: "done", system: "i9", durationSec: 88, keyLines: ["6 pages · 5 with a contact block"] },
    { label: "Your review", state: "done", durationSec: 61, keyLines: ["approved 5/5 at 3:31 PM"] },
    { label: "Member fan-out", state: "done", system: "ucpath", durationSec: 92 },
    { label: "Rollup", state: "done", durationSec: 2, keyLines: ["5 verified · 1 rejected page excluded from the rollup"] },
  ],
  lines: [
    { ts: "3:28:02", kind: "event", text: "Upload — EC_Forms_0722.pdf · 6 pages", step: "OCR extraction" },
    { ts: "3:29:44", kind: "warn", system: "i9", text: "Page 7 has no contact block — rejected member row emitted (delete-only)", step: "OCR extraction" },
    { ts: "3:31:10", kind: "event", text: "You approved 5 of 5 readable records", step: "Your review" },
    { ts: "3:32:08", kind: "ok", text: "All 5 contacts saved and read back", step: "Member fan-out" },
    {
      ts: "3:32:10",
      kind: "warn",
      text: "Rollup — 5 of 5 real members verified, but 1 rejected page is unresolved, so the packet is Done with warnings, not Verified done",
      step: "Rollup",
    },
  ],
  data: [
    { step: "OCR extraction", dir: "read", field: "Pages with a contact block", value: "5 of 6", system: "i9", ts: "3:29:44" },
    { step: "Member fan-out", dir: "write", field: "Contacts saved", value: "5 of 5", system: "ucpath", ts: "3:32:08" },
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

const ecSingleMember: DemoRow = {
  id: "ecs-m-0",
  rowType: "member",
  parentId: "ec-single",
  containment: "member",
  wfLabel: "Emergency Contact",
  title: "Yara Ito",
  eid: "10466920",
  trace: "ec-160412-m00",
  status: "verifiedDone",
  time: "4:05 PM",
  run: 1,
  duration: "31s",
  memberFact: "contact saved · parent",
  outcome: { tone: "success", text: "Emergency contact saved and read back from UCPath" },
  steps: [
    { label: "Navigation", state: "done", system: "ucpath", durationSec: 9 },
    { label: "Fill form", state: "done", system: "ucpath", durationSec: 15 },
    { label: "Save", state: "done", system: "ucpath", durationSec: 7, hasShot: true },
  ],
  lines: [{ ts: "4:05:31", kind: "write", system: "ucpath", pills: [{ dir: "write", label: "contact", value: "parent" }], step: "Fill form" }],
  data: [{ step: "Fill form", dir: "write", field: "Relationship", value: "parent", system: "ucpath", ts: "4:05:31" }],
  receipt: {
    tone: "success",
    headline: "Verified done · contact saved",
    lines: [{ label: "Relationship", value: "parent", verified: true }],
  },
  shots: [{ label: "Saved contact", kind: "step" }],
};

const ecSingle: DemoRow = {
  id: "ec-single",
  rowType: "group",
  subjectKind: "file",
  wfLabel: "Emergency Contact",
  title: "EC_Form_Ito.pdf",
  trace: "ec-160412-3a77",
  status: "verifiedDone",
  time: "4:04 PM",
  run: 1,
  duration: "1m 48s",
  memberIds: ["ecs-m-0"],
  outcome: { tone: "success", text: "1 of 1 saved — a packet of one is still a packet", action: "Open receipt" },
  steps: [
    { label: "OCR extraction", state: "done", system: "i9", durationSec: 34, keyLines: ["1 page · 1 contact block"] },
    { label: "Your review", state: "done", durationSec: 41 },
    { label: "Member fan-out", state: "done", system: "ucpath", durationSec: 31 },
    { label: "Rollup", state: "done", durationSec: 2 },
  ],
  lines: [
    { ts: "4:04:12", kind: "event", text: "Upload — EC_Form_Ito.pdf · 1 page", step: "OCR extraction" },
    { ts: "4:05:02", kind: "event", text: "You approved 1 of 1", step: "Your review" },
    { ts: "4:06:00", kind: "ok", text: "Rollup complete — 1 contact saved", step: "Rollup" },
  ],
  data: [{ step: "Member fan-out", dir: "write", field: "Contacts saved", value: "1 of 1", system: "ucpath", ts: "4:06:00" }],
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

const ocrOnbase: DemoRow = {
  id: "ocr-onbase",
  rowType: "run",
  subjectKind: "file",
  wfLabel: "OCR",
  title: "OnBase_Import_0722.pdf",
  trace: "oc-155902-e440",
  status: "failed",
  time: "3:59 PM",
  run: 2,
  duration: "1m 12s",
  containment: "linked",
  linkedParentId: "ob-packet",
  reviewOf: "ob-packet",
  records: [],
  error: "0 of 14 pages were readable — the PDF is a flattened fax scan at 96 dpi",
  failShots: 2,
  outcome: { tone: "destructive", text: "OCR failed — 0 of 14 pages readable (96 dpi fax scan)", action: "Re-upload" },
  steps: [
    { label: "Split pages", state: "done", system: "i9", durationSec: 8, keyLines: ["14 pages"] },
    { label: "Read forms", state: "failed", system: "i9", durationSec: 64, attempts: 2, keyLines: ["0 of 14 pages produced a record", "page raster is 96 dpi — below the readable floor"] },
    { label: "Roster match", state: "pending", system: "i9" },
    { label: "Your review", state: "pending" },
  ],
  lines: [
    { ts: "3:59:10", kind: "event", system: "i9", text: "Split 14 pages", step: "Split pages" },
    { ts: "4:00:14", kind: "error", system: "i9", text: "0 of 14 pages produced a record — the raster is 96 dpi, below the readable floor", card: "failure", step: "Read forms" },
  ],
  data: [{ step: "Read forms", dir: "read", field: "Records read", value: "0 of 14", system: "i9", ts: "4:00:14" }],
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

const obPacket: DemoRow = {
  id: "ob-packet",
  rowType: "group",
  subjectKind: "file",
  wfLabel: "OnBase",
  title: "OnBase_Import_0722.pdf",
  trace: "ob-155900-1c08",
  status: "failed",
  time: "3:59 PM",
  run: 2,
  duration: "1m 20s",
  memberIds: [],
  reviewRunId: "ocr-onbase",
  mirroredFrom: "ocr-onbase",
  error: "OCR failed — 0 of 14 pages were readable (96 dpi fax scan)",
  outcome: {
    tone: "destructive",
    text: "Failed — its OCR run could not read the packet: 0 of 14 pages readable (96 dpi fax scan)",
    action: "Re-upload",
  },
  steps: [
    { label: "OCR extraction", state: "failed", system: "i9", durationSec: 72, keyLines: ["delegated to oc-155902-e440", "child failed — 0 of 14 pages readable"] },
    { label: "Your review", state: "pending" },
    { label: "Member fan-out", state: "pending", system: "onbase" },
    { label: "Rollup", state: "pending" },
  ],
  lines: [
    { ts: "3:59:00", kind: "event", text: "Upload — OnBase_Import_0722.pdf · 14 pages", step: "OCR extraction" },
    { ts: "3:59:02", kind: "event", text: "Delegated extraction to the OCR panel — oc-155902-e440", step: "OCR extraction" },
    {
      ts: "4:00:20",
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
// Assembly + ordering helpers
// ===========================================================================

export const DEMO_ROWS: Record<string, DemoRow> = Object.fromEntries(
  [
    // needs you
    oathSummer,
    ocrSummer,
    sepMaria,
    sepRosa,
    // active
    i9Batch,
    ouPacket,
    wsBatch,
    plDaniel,
    krReports,
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
    // members + linked children
    ...i9MemberIds.map((_, i) => i9Member(i)),
    ...oathMemberIds.map((_, i) => oathMember(i)),
    ...wsMemberIds.map((_, i) => wsMember(i)),
    ...ecPacketMemberIds.map((_, i) => ecPacketMember(i)),
    ecSingleMember,
    ...OU_SIGNER_IDS.map((_, i) => ouSigner(i)),
  ].map((r) => [r.id, r]),
);

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

/** the age of the decision this row is sitting on, if it is sitting on one */
export function gateAge(row: DemoRow): string | undefined {
  return row.gate?.waiting;
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
// ---------------------------------------------------------------------------

export type DensityRung = "inline" | "compact" | "well" | "matrix";

/** the ratified threshold: below this a person is still a line, at or above it a cell */
export const MATRIX_THRESHOLD = 41;

export function densityRung(memberCount: number): DensityRung {
  if (memberCount <= 3) return "inline";
  if (memberCount <= 12) return "compact";
  if (memberCount < MATRIX_THRESHOLD) return "well";
  return "matrix";
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
    range: "13–40 members",
    what: "The same compact lines in a fixed-height scroll well, plus Open all N. The row keeps its height whether it holds 13 people or 40.",
    exampleId: "ws-batch",
  },
  {
    key: "matrix",
    range: "41+ members",
    what: "A status matrix — one cell per person — with the attention strip ABOVE it and a Start review drill-in. The matrix is the overview, never the review.",
    exampleId: "i9-batch",
  },
];

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
  firstId: string;
  panel: string;
}

export function linkedGroupSummary(row: DemoRow): LinkedGroupSummary | null {
  const g = row.linkedGroup;
  if (!g || g.ids.length === 0) return null;
  const rows = g.ids.map((id) => DEMO_ROWS[id]).filter(Boolean);
  const done = rows.filter((r) => r.status === "verifiedDone" || r.status === "doneWarnings").length;
  return { total: rows.length, done, label: `${rows.length} ${g.noun} · ${done} done`, firstId: g.ids[0], panel: g.panel };
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

/** seconds → "14s" / "1m 4s" / "1h 3m" */
export function fmtElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}
