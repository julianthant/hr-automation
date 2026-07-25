/**
 * DEV-ONLY — the rebuild demo's world model (`?view=rebuild-demo`).
 *
 * One typed source of truth: every queue row — the 3 ratified row types
 * (run / group / member) across all 8 ratified statuses — carries its OWN
 * pipeline, log stream, data ledger, gate, receipt, and screenshot set, so the
 * demo log panel derives entirely per-row. Deterministic content only (stable
 * screenshots, no randomness).
 */

import type { ProposedStatus } from "../proposals/proposal-rows";

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
  staged?: boolean;
}

export interface DemoGate {
  kind: "identity" | "parked" | "approval";
  title: string;
  openedAt: string;
  waiting: string;
  candidates?: { heading: string; name: string; sub: string }[];
  staged?: { field: string; value: string; system: SystemKey }[];
  /** first action renders primary */
  actions: string[];
  note: string;
}

export interface DemoReceipt {
  tone: "success" | "warning" | "muted" | "destructive";
  headline: string;
  lines?: { label: string; value: string; verified?: boolean }[];
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
  /** the member row this record fans out to once approved */
  memberId?: string;
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
  waitingLabel?: string;
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
  /** group only — the delegated OCR Review Row that owns this packet's records */
  reviewRunId?: string;
  /** review run only — the records the operator works through, and the group they belong to */
  records?: DemoRecord[];
  reviewOf?: string;
  /** member only */
  parentId?: string;
  memberFact?: string;
  /** member only — the OCR record this member was fanned out from */
  recordId?: string;
  displayOnly?: boolean;
  checkedByDefault?: boolean;
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
  waitingLabel: "waiting 18m",
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
  waitingLabel: "parked 32m",
  outcome: { tone: "violet", text: "UCPath termination write verified & staged — parked before submit", action: "Resume" },
  steps: [
    { label: "Kuali extraction", state: "done", system: "kuali", durationSec: 38, hasShot: true },
    { label: "Identity check", state: "done", system: "ucpath", durationSec: 9 },
    { label: "Job summary", state: "done", system: "ucpath", durationSec: 20, hasShot: true },
    { label: "Kronos search", state: "done", system: "kronos", durationSec: 41 },
    { label: "UCPath transaction", state: "waiting", system: "ucpath", keyLines: ["write staged · fields verified", "parked by write-safety policy"] },
    { label: "Kuali finalization", state: "pending", system: "kuali" },
  ],
  lines: [
    { ts: "1:48:40", kind: "ok", text: "Extraction + identity + Kronos complete — no discrepancies", duration: "1m 48s", step: "Earlier steps" },
    { ts: "1:50:02", kind: "nav", system: "ucpath", text: "Smart HR termination template open", step: "UCPath transaction" },
    { ts: "1:50:31", kind: "write", system: "ucpath", pills: [{ dir: "write", label: "separation date", value: "07/18/2026" }, { dir: "write", label: "action", value: "Voluntary termination" }], text: undefined, step: "UCPath transaction" },
    { ts: "1:50:44", kind: "ok", text: "All fields verified against Kuali source — form filled, NOT submitted", step: "UCPath transaction" },
    { ts: "1:50:45", kind: "pause", text: "Write parked — submit is held for operator resume (write-safety policy for terminations).", card: "gate", step: "UCPath transaction" },
  ],
  data: [
    { step: "Kuali extraction", dir: "read", field: "Last day worked", value: "07/17/2026", system: "kuali", ts: "1:48:22" },
    { step: "Kuali extraction", dir: "read", field: "Separation date", value: "07/18/2026", system: "kuali", ts: "1:48:22" },
    { step: "Kronos search", dir: "read", field: "Last punch", value: "07/16/2026", system: "kronos", ts: "1:49:58" },
    { step: "UCPath transaction", dir: "write", field: "Separation date", value: "07/18/2026", system: "ucpath", ts: "1:50:31", staged: true },
    { step: "UCPath transaction", dir: "write", field: "Action", value: "Voluntary termination", system: "ucpath", ts: "1:50:31", staged: true },
  ],
  gate: {
    kind: "parked",
    title: "Write parked — staged & verified, held for your resume",
    openedAt: "1:50 PM",
    waiting: "32m",
    staged: [
      { field: "Separation date", value: "07/18/2026", system: "ucpath" },
      { field: "Action", value: "Voluntary termination", system: "ucpath" },
    ],
    actions: ["Resume & submit", "Open form screenshot", "Cancel run"],
    note: "The form is filled and field-verified in UCPath but not submitted. Resume submits and then read-back verifies; Cancel leaves UCPath untouched.",
  },
  receipt: {
    tone: "muted",
    headline: "Receipt — pending",
    note: "The staged termination write is verified against the Kuali source. The receipt is issued after Resume → submit → read-back.",
  },
  shots: [
    { label: "Kuali doc", kind: "step" },
    { label: "Job summary", kind: "step" },
    { label: "Filled form (parked)", kind: "form" },
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
  wfLabel: "Oath Signature",
  title: "Oath_Packet_Spring.pdf",
  trace: "os-110501-c2f0",
  status: "doneWarnings",
  time: "11:05 AM",
  run: 4,
  duration: "18m 40s",
  warnings: { count: 1, first: "1 signer failed — signature field never rendered" },
  memberIds: oathMemberIds,
  outcome: { tone: "warning", text: "11/12 signed · Grace Egan failed — signature field never rendered", action: "Open failure" },
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
    headline: "Done with warnings · 11/12 signed",
    lines: [
      { label: "Signed", value: "11 signers · 11:08–11:23 AM", verified: true },
      { label: "Failed", value: "Grace Egan — signature field never rendered" },
      { label: "Source packet", value: "Oath_Packet_Spring.pdf · 12 pages" },
    ],
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

const FIRST = [
  "Ana", "Ben", "Carla", "Diego", "Emma", "Felix", "Grace", "Hugo", "Iris", "Jonah",
  "Kara", "Liam", "Mona", "Noel", "Opal", "Pablo", "Quinn", "Rita", "Sam", "Tara",
  "Uma", "Victor", "Wren", "Xena", "Yara",
];
const LAST = ["Alvarez", "Brooks", "Chen", "Diaz", "Egan", "Flores", "Garcia", "Hahn", "Ito", "Jones"];

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

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

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
// A Packet Group Row (oath-summer) whose members are all still queued behind
// the operator's decision, plus the delegated OCR Review Row (ocr-summer) that
// OWNS the per-person records. This is the D4 shape: the OCR run keeps its own
// row and the group links to it.
// ===========================================================================

const summerMemberIds = Array.from({ length: 6 }, (_, i) => `os2-m-${i}`);

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
    memberId: `os2-m-${i}`,
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
  waitingLabel: "waiting 10m",
  ocrPhase: "6 people extracted — waiting on your review",
  memberIds: summerMemberIds,
  reviewRunId: "ocr-summer",
  outcome: {
    tone: "warning",
    text: "Waiting on you — review 6 people, then approve. Nothing is written until you do.",
    action: "Review people",
  },
  steps: [
    { label: "OCR extraction", state: "done", system: "i9", durationSec: 128, keyLines: ["6 people on 8 pages", "2 pages had no form"] },
    { label: "Roster match", state: "done", system: "i9", durationSec: 31, keyLines: ["6/6 matched to the July roster"] },
    { label: "Your review", state: "waiting", keyLines: ["0 of 6 reviewed"] },
    { label: "Signer fan-out", state: "pending", system: "ucpath" },
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
    note: "Review each person against their page, then approve. Approving fans out one signer task per approved person; Diego Diaz is blocked (inactive) and is excluded from the count.",
    actions: ["Open review", "Approve 5 of 6", "Discard packet"],
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
  waitingLabel: "waiting 10m",
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
    { label: "Person lookup", state: "done", system: "ucpath", durationSec: 44, keyLines: ["6 lookups · 1 inactive"] },
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

function summerMember(i: number): DemoRow {
  const p = SUMMER_PEOPLE[i];
  const blocked = p.state === "blocked";
  return {
    id: `os2-m-${i}`,
    rowType: "member",
    parentId: "oath-summer",
    wfLabel: "Oath Signature",
    title: p.name,
    eid: p.eid,
    trace: `os-142012-n${pad(i, 2)}`,
    status: "queued",
    time: "2:22 PM",
    run: 1,
    memberFact: blocked ? "blocked — inactive in UCPath" : p.state === "warn" ? "flagged in review" : "awaiting approval",
    queueNote: blocked ? "blocked — cannot be approved" : "held until you approve the packet",
    recordId: `rec-${i}`,
    outcome: blocked
      ? { tone: "destructive", text: "Blocked — UCPath shows this person separated 06/30/2026. Not included in Approve." }
      : { tone: "muted", text: "Held — this signer runs only after you approve the packet.", action: "Open review" },
    steps: [
      { label: "CRM verify", state: "pending", system: "crm" },
      { label: "UCPath auth", state: "pending", system: "ucpath" },
      { label: "Sign oath", state: "pending", system: "ucpath" },
    ],
    lines: [
      { ts: "2:22:51", kind: "event", text: `Member created from ${`page ${p.page}`} — waiting on packet approval`, step: "Queued" },
    ],
    data: [],
    receipt: { tone: "muted", headline: "Receipt — pending", note: "Nothing has run for this person yet." },
    shots: [],
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
  status: "verifiedDone",
  time: "10:12 AM",
  run: 7,
  duration: "6m 12s",
  receiptShield: "TKT0094412",
  facts: [
    { label: "pages", value: "4" },
    { label: "ticket", value: "TKT0094412" },
  ],
  outcome: { tone: "success", text: "Filed — ServiceNow ticket TKT0094412 · 4 signed oaths attached", action: "Open receipt" },
  steps: [
    { label: "OCR prep", state: "done", system: "i9", durationSec: 96, keyLines: ["4 signed oaths recognised"] },
    { label: "Your review", state: "done", durationSec: 141, keyLines: ["approved 4/4 at 10:15 AM"] },
    { label: "Wait signatures", state: "done", system: "ucpath", durationSec: 92 },
    { label: "File ticket", state: "done", system: "servicenow", durationSec: 43, hasShot: true },
  ],
  lines: [
    { ts: "10:12:04", kind: "event", text: "Upload — Signed_Oaths_0724.pdf · 4 pages", step: "OCR prep" },
    { ts: "10:13:40", kind: "ok", system: "i9", text: "4 signed oaths recognised · all 4 matched to signed UCPath records", step: "OCR prep" },
    { ts: "10:15:01", kind: "event", text: "You approved 4 of 4", step: "Your review" },
    { ts: "10:17:33", kind: "write", system: "servicenow", pills: [{ dir: "write", label: "ticket", value: "TKT0094412" }], step: "File ticket" },
    { ts: "10:18:16", kind: "ok", system: "servicenow", text: "Ticket filed and read back — 4 attachments confirmed", duration: "43s", step: "File ticket" },
  ],
  data: [
    { step: "OCR prep", dir: "read", field: "Signed oaths found", value: "4", system: "i9", ts: "10:13:40" },
    { step: "File ticket", dir: "write", field: "ServiceNow ticket", value: "TKT0094412", system: "servicenow", ts: "10:17:33" },
    { step: "File ticket", dir: "write", field: "Attachments", value: "4 pages", system: "servicenow", ts: "10:17:33" },
  ],
  receipt: {
    tone: "success",
    headline: "Verified done · ticket TKT0094412",
    lines: [
      { label: "Ticket", value: "TKT0094412", verified: true },
      { label: "Attachments", value: "4 signed oaths · read back", verified: true },
      { label: "Filed", value: "10:18 AM · 6m 12s" },
    ],
    note: "One row, one document, one ticket — this workflow files its own ticket instead of fanning out. Nothing else to check.",
  },
  shots: [
    { label: "Ticket confirmation", kind: "step" },
    { label: "Attachment list", kind: "form" },
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
// Assembly + ordering helpers
// ===========================================================================

export const DEMO_ROWS: Record<string, DemoRow> = Object.fromEntries(
  [
    sepMaria,
    sepRosa,
    plDaniel,
    i9Batch,
    oathBatch,
    onbJordan,
    kpMarcus,
    obElena,
    cdSamuel,
    wsPriya,
    ecTomas,
    oathSummer,
    ocrSummer,
    ouPacket,
    krReports,
    ...i9MemberIds.map((_, i) => i9Member(i)),
    ...oathMemberIds.map((_, i) => oathMember(i)),
    ...summerMemberIds.map((_, i) => summerMember(i)),
  ].map((r) => [r.id, r]),
);

/** queue order inside attention bands */
export const BAND_ORDER: { key: "attention" | "active" | "queued" | "finished"; label: string; ids: string[] }[] = [
  { key: "attention", label: "Needs you", ids: ["oath-summer", "ocr-summer", "sep-maria", "sep-rosa"] },
  { key: "active", label: "Active", ids: ["pl-daniel", "i9-batch", "kr-reports"] },
  { key: "queued", label: "Queued", ids: ["ws-priya"] },
  { key: "finished", label: "Finished today", ids: ["oath-batch", "ou-packet", "onb-jordan", "kp-marcus", "ob-elena", "cd-samuel", "ec-tomas"] },
];

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
    const rankA = ra.displayOnly ? 5 : MEMBER_ATTENTION_RANK[ra.status];
    const rankB = rb.displayOnly ? 5 : MEMBER_ATTENTION_RANK[rb.status];
    return rankA - rankB || a.localeCompare(b);
  });
}

export function memberAttentionIds(groupId: string): string[] {
  return orderedMemberIds(groupId).filter((id) => {
    const r = DEMO_ROWS[id];
    return !r.displayOnly && ATTENTION_STATUSES.includes(r.status);
  });
}

export interface GroupCounts {
  done: number;
  running: number;
  queued: number;
  failed: number;
  warnings: number;
  waiting: number;
  rejected: number;
}

export function groupCounts(groupId: string): GroupCounts {
  const out: GroupCounts = { done: 0, running: 0, queued: 0, failed: 0, warnings: 0, waiting: 0, rejected: 0 };
  for (const id of DEMO_ROWS[groupId]?.memberIds ?? []) {
    const r = DEMO_ROWS[id];
    if (r.displayOnly) out.rejected += 1;
    else if (r.status === "verifiedDone") out.done += 1;
    else if (r.status === "doneWarnings") out.warnings += 1;
    else if (r.status === "running") out.running += 1;
    else if (r.status === "queued") out.queued += 1;
    else if (r.status === "waiting") out.waiting += 1;
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
