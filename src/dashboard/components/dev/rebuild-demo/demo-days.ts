/**
 * DEV-ONLY — the rebuild demo's DATE AXIS.
 *
 * The queue is day-partitioned in production (`.tracker/rows/{workflow}-{date}.jsonl`),
 * so the demo has to be too. Before this file the top bar said one date, the
 * queue held another, and the ‹ › controls were NOOPs — three ways of lying
 * about the same fact.
 *
 * What this adds: two prior days of finished work beside today's live corpus,
 * and ONE function (`topLevelRowsForDay`) that every surface goes through. The
 * rail badges, the Status Bar pills and the visible rows are all computed from
 * whatever that function returns, so moving the date moves the counts WITH it —
 * they cannot disagree, because there is nothing for them to disagree about.
 *
 * The prior-day rows are projected through `projectRow` — the same mock server
 * as today's rows — so a Wednesday row is not a second, thinner model.
 */

import { projectRow, type DemoRow, type DemoRowSpec } from "./demo-data";
import { DEMO_ROWS } from "./demo-data";
import { DEMO_DAY, fmtDayLabel } from "./demo-wire";

/** every day the tracker holds, oldest first. Today is the last entry. */
export const DEMO_DAYS: string[] = ["2026-07-23", "2026-07-24", DEMO_DAY];

/** re-exported so a surface needs ONE import for "the days and today" */
export { DEMO_DAY } from "./demo-wire";

/** an instant on a specific day — the prior-day sibling of `demo-wire`'s `at()` */
function on(day: string, clock: string): string {
  return `${day}T${clock}`;
}

/** the day a row belongs to. Partitioning is by ENQUEUE, exactly like the files. */
export function dayOfRow(row: DemoRow): string {
  return row.enqueuedAt.slice(0, 10);
}

export function dayLabel(day: string): string {
  return fmtDayLabel(`${day}T12:00:00`);
}

/** `Thu, Jul 23` → `Thu, Jul 23 · today` when it is the live day */
export function dayLabelWithToday(day: string): string {
  return day === DEMO_DAY ? `${dayLabel(day)} · today` : dayLabel(day);
}

export function dayIndex(day: string): number {
  return DEMO_DAYS.indexOf(day);
}

const WED = "2026-07-23";
const THU = "2026-07-24";

// ---------------------------------------------------------------------------
// Wednesday — the oldest day the tracker still holds
// ---------------------------------------------------------------------------

const sepVictor: DemoRowSpec = {
  id: "d1-sep-victor",
  rowType: "run",
  workflowId: "separations",
  title: "Victor Amaya",
  eid: "10412886",
  runId4: "7ab2",
  status: "verifiedDone",
  run: 1,
  version: 4,
  enqueuedAt: on(WED, "09:12:40"),
  startedAt: on(WED, "09:12:48"),
  endedAt: on(WED, "09:19:02"),
  evidence: { receiptId: "rcpt-se-7ab2", confidence: "verified" },
  facts: [
    { label: "separation", value: "07/10/2026" },
    { label: "txn", value: "TXN-0884019" },
  ],
  outcome: { tone: "success", text: "Terminated 07/10/2026 · TXN-0884019 read back from UCPath" },
  steps: [
    { label: "Kuali extraction", state: "done", system: "kuali", durationSec: 44, hasShot: true },
    { label: "Identity check", state: "done", system: "ucpath", durationSec: 11 },
    { label: "Kronos search", state: "done", system: "kronos", durationSec: 52 },
    { label: "UCPath transaction", state: "done", system: "ucpath", durationSec: 168, keyLines: ["TXN-0884019 · read-back ✓"], hasShot: true },
    { label: "Kuali finalization", state: "done", system: "kuali", durationSec: 96 },
  ],
  lines: [
    { ts: "9:13:32", kind: "read", system: "kuali", pills: [{ dir: "read", label: "separation date", value: "07/10/2026" }], step: "Kuali extraction" },
    { ts: "9:15:20", kind: "write", system: "ucpath", text: "Termination submitted", step: "UCPath transaction" },
    { ts: "9:16:11", kind: "ok", system: "ucpath", text: "TXN-0884019 read back on the confirmation page", step: "UCPath transaction" },
    { ts: "9:19:02", kind: "ok", system: "kuali", text: "Kuali document finalized", duration: "1m 36s", step: "Kuali finalization" },
  ],
  data: [
    { step: "Kuali extraction", dir: "read", field: "Separation date", value: "07/10/2026", system: "kuali", ts: "9:13:32" },
    { step: "Kuali extraction", dir: "read", field: "Last day worked", value: "07/09/2026", system: "kuali", ts: "9:13:32" },
    { step: "UCPath transaction", dir: "write", field: "Separation date", value: "07/10/2026", system: "ucpath", ts: "9:15:20" },
    { step: "UCPath transaction", dir: "write", field: "Transaction number", value: "TXN-0884019", system: "ucpath", ts: "9:16:11" },
  ],
  receipt: {
    tone: "success",
    headline: "Done · termination filed",
    lines: [
      { label: "Separation date", value: "07/10/2026", verified: true },
      { label: "Transaction", value: "TXN-0884019", verified: true },
      { label: "Finished", value: "9:19 AM · 6m 14s active" },
    ],
  },
  shots: [
    { label: "Kuali doc", kind: "step" },
    { label: "TXN confirmation", kind: "step" },
  ],
};

const ecNoor: DemoRowSpec = {
  id: "d1-ec-noor",
  rowType: "run",
  workflowId: "emergency-contact",
  title: "Noor Haddad",
  eid: "10559043",
  runId4: "3e10",
  status: "cancelled",
  run: 1,
  version: 3,
  enqueuedAt: on(WED, "10:48:11"),
  startedAt: on(WED, "10:48:19"),
  endedAt: on(WED, "10:49:57"),
  evidence: { confidence: "unknown" },
  outcome: { tone: "muted", text: "Cancelled by you before the form was submitted — nothing was written" },
  steps: [
    { label: "UCPath auth", state: "done", system: "ucpath", durationSec: 28 },
    { label: "Contact form", state: "cancelled", system: "ucpath", durationSec: 70 },
  ],
  lines: [
    { ts: "10:48:47", kind: "ok", system: "ucpath", text: "Authenticated", step: "UCPath auth" },
    { ts: "10:49:57", kind: "event", text: "Cancelled by local-operator — the form was open but never submitted", step: "Contact form" },
  ],
  data: [{ step: "Contact form", dir: "read", field: "Contact name (input)", value: "Haddad, Rami", system: "ucpath", ts: "10:49:02" }],
  receipt: {
    tone: "muted",
    headline: "No receipt — the run was stopped before any write",
    note: "Cancelling is not an undo, but there was nothing to undo: the form was open and never submitted.",
  },
  shots: [{ label: "Contact form", kind: "form" }],
};

const wsTomas: DemoRowSpec = {
  id: "d1-ws-tomas",
  rowType: "run",
  workflowId: "work-study",
  title: "Tomás Ferreira",
  eid: "10488210",
  runId4: "b64c",
  status: "verifiedDone",
  run: 2,
  version: 6,
  enqueuedAt: on(WED, "13:02:05"),
  startedAt: on(WED, "13:02:12"),
  endedAt: on(WED, "13:05:41"),
  evidence: { receiptId: "rcpt-ws-b64c", confidence: "verified" },
  outcome: { tone: "success", text: "Work-study award updated to $3,200 · read back" },
  steps: [
    { label: "UCPath auth", state: "done", system: "ucpath", durationSec: 31 },
    { label: "Award update", state: "done", system: "ucpath", durationSec: 178, hasShot: true },
  ],
  lines: [
    { ts: "1:02:43", kind: "ok", system: "ucpath", text: "Authenticated", step: "UCPath auth" },
    { ts: "1:05:41", kind: "write", system: "ucpath", pills: [{ dir: "write", label: "award", value: "$3,200" }], step: "Award update" },
  ],
  data: [
    { step: "Award update", dir: "read", field: "Prior award", value: "$2,400", system: "ucpath", ts: "1:03:20" },
    { step: "Award update", dir: "write", field: "Award", value: "$3,200", system: "ucpath", ts: "1:05:41" },
  ],
  receipt: {
    tone: "success",
    headline: "Done · award updated",
    lines: [
      { label: "Prior award", value: "$2,400" },
      { label: "New award", value: "$3,200", verified: true },
    ],
  },
  shots: [{ label: "Award page", kind: "step" }],
};

// ---------------------------------------------------------------------------
// Thursday — yesterday
// ---------------------------------------------------------------------------

const sepLena: DemoRowSpec = {
  id: "d2-sep-lena",
  rowType: "run",
  workflowId: "separations",
  title: "Lena Okafor",
  eid: "10502914",
  runId4: "d91f",
  status: "verifiedDone",
  run: 1,
  version: 5,
  enqueuedAt: on(THU, "08:41:22"),
  startedAt: on(THU, "08:41:31"),
  endedAt: on(THU, "08:47:10"),
  evidence: { receiptId: "rcpt-se-d91f", confidence: "verified" },
  facts: [{ label: "txn", value: "TXN-0887730" }],
  outcome: { tone: "success", text: "Terminated 07/15/2026 · TXN-0887730 read back from UCPath" },
  steps: [
    { label: "Kuali extraction", state: "done", system: "kuali", durationSec: 40 },
    { label: "Identity check", state: "done", system: "ucpath", durationSec: 10 },
    { label: "UCPath transaction", state: "done", system: "ucpath", durationSec: 190, hasShot: true },
    { label: "Kuali finalization", state: "done", system: "kuali", durationSec: 99 },
  ],
  lines: [
    { ts: "8:42:11", kind: "read", system: "kuali", pills: [{ dir: "read", label: "separation date", value: "07/15/2026" }], step: "Kuali extraction" },
    { ts: "8:46:02", kind: "ok", system: "ucpath", text: "TXN-0887730 read back", step: "UCPath transaction" },
  ],
  data: [
    { step: "Kuali extraction", dir: "read", field: "Separation date", value: "07/15/2026", system: "kuali", ts: "8:42:11" },
    { step: "UCPath transaction", dir: "write", field: "Transaction number", value: "TXN-0887730", system: "ucpath", ts: "8:46:02" },
  ],
  receipt: {
    tone: "success",
    headline: "Done · termination filed",
    lines: [
      { label: "Separation date", value: "07/15/2026", verified: true },
      { label: "Transaction", value: "TXN-0887730", verified: true },
    ],
  },
  shots: [{ label: "TXN confirmation", kind: "step" }],
};

const onbAmir: DemoRowSpec = {
  id: "d2-onb-amir",
  rowType: "run",
  workflowId: "onboarding",
  title: "Amir Solberg",
  eid: "10644771",
  runId4: "5c08",
  status: "doneWarnings",
  run: 1,
  version: 8,
  enqueuedAt: on(THU, "10:15:03"),
  startedAt: on(THU, "10:15:12"),
  endedAt: on(THU, "10:24:48"),
  evidence: { receiptId: "rcpt-on-5c08", confidence: "partial" },
  warnings: { count: 1, first: "An I-9 profile already existed — the run reused it instead of creating a second one" },
  outcome: { tone: "warning", text: "Hired, with 1 warning — the I-9 profile already existed and was reused, not created" },
  steps: [
    { label: "CRM extraction", state: "done", system: "crm", durationSec: 71 },
    { label: "Person search", state: "done", system: "ucpath", durationSec: 22 },
    { label: "I-9 creation", state: "done", system: "i9", durationSec: 48, keyLines: ["profile PRF-117884 already present — reused"] },
    { label: "SmartHR transaction", state: "done", system: "ucpath", durationSec: 194, hasShot: true },
  ],
  lines: [
    { ts: "10:16:23", kind: "read", system: "crm", pills: [{ dir: "read", label: "wage", value: "$17.25/hr" }], step: "CRM extraction" },
    { ts: "10:19:40", kind: "warn", system: "i9", text: "I-9 profile PRF-117884 already exists for this person — reusing it, not creating a second", step: "I-9 creation" },
    { ts: "10:24:48", kind: "ok", system: "ucpath", text: "TXN-0888104 read back", step: "SmartHR transaction" },
  ],
  data: [
    { step: "CRM extraction", dir: "read", field: "Wage", value: "$17.25/hr", system: "crm", ts: "10:16:23" },
    { step: "I-9 creation", dir: "read", field: "Existing I-9 profile", value: "PRF-117884", system: "i9", ts: "10:19:40" },
    { step: "SmartHR transaction", dir: "write", field: "Transaction number", value: "TXN-0888104", system: "ucpath", ts: "10:24:48" },
  ],
  receipt: {
    tone: "warning",
    headline: "Done with warnings · hire submitted, I-9 profile reused",
    lines: [
      { label: "Wage", value: "$17.25/hr", verified: true },
      { label: "Transaction", value: "TXN-0888104", verified: true },
      { label: "I-9 profile", value: "PRF-117884 (pre-existing)" },
    ],
    note: "The warning is the point: a second I-9 profile was NOT created. Nothing here needs redoing.",
  },
  shots: [{ label: "SmartHR form", kind: "form" }],
};

const obPriyanka: DemoRowSpec = {
  id: "d2-ob-priyanka",
  rowType: "run",
  workflowId: "onbase",
  title: "Priyanka Rao",
  eid: "10598002",
  runId4: "a2e6",
  status: "failed",
  run: 3,
  version: 4,
  attempt: 2,
  attemptHistory: { n: 2, prior: "ob-104412-9c11" },
  enqueuedAt: on(THU, "14:52:44"),
  startedAt: on(THU, "14:52:51"),
  endedAt: on(THU, "14:55:09"),
  evidence: { failureId: "fail-ob-a2e6", confidence: "unknown" },
  error: "OnBase rejected the document type — “I-9 Supporting” is not enabled for this queue",
  failCard: {
    title: "OnBase rejected the document type",
    meta: "fingerprint onbase/doc-type-not-enabled · seen 3× this month · attempt 2 of 2",
  },
  outcome: { tone: "destructive", text: "Failed — OnBase rejected the document type, twice. The queue needs enabling before a retry can work." },
  steps: [
    { label: "OnBase auth", state: "done", system: "onbase", durationSec: 26 },
    { label: "Document upload", state: "failed", system: "onbase", durationSec: 112, attempts: 2, hasShot: true },
  ],
  lines: [
    { ts: "2:53:17", kind: "ok", system: "onbase", text: "Authenticated", step: "OnBase auth" },
    { ts: "2:55:09", kind: "error", system: "onbase", text: "Rejected: document type “I-9 Supporting” is not enabled for queue SDCMP-HR", card: "failure", step: "Document upload" },
  ],
  data: [{ step: "Document upload", dir: "read", field: "Document type", value: "I-9 Supporting", system: "onbase", ts: "2:53:40" }],
  receipt: {
    tone: "destructive",
    headline: "No receipt — nothing was filed",
    note: "Two attempts, the same rejection both times. Retrying without enabling the document type will fail a third time.",
  },
  shots: [
    { label: "Upload form", kind: "form" },
    { label: "Rejection dialog", kind: "error" },
  ],
};

const krThursday: DemoRowSpec = {
  id: "d2-kr-report",
  rowType: "run",
  subjectKind: "catalog",
  workflowId: "old-kronos-reports",
  title: "Timecard exceptions · SDCMP",
  runId4: "0f77",
  status: "verifiedDone",
  run: 12,
  version: 3,
  enqueuedAt: on(THU, "16:30:00"),
  startedAt: on(THU, "16:30:04"),
  endedAt: on(THU, "16:33:19"),
  evidence: { receiptId: "rcpt-kr-0f77", confidence: "verified" },
  outcome: { tone: "success", text: "Downloaded 1 report · 214 rows · saved to the reports folder" },
  steps: [
    { label: "Kronos auth", state: "done", system: "kronos", durationSec: 29 },
    { label: "Report run", state: "done", system: "kronos", durationSec: 166, hasShot: true },
  ],
  lines: [
    { ts: "4:30:33", kind: "ok", system: "kronos", text: "Authenticated", step: "Kronos auth" },
    { ts: "4:33:19", kind: "ok", system: "kronos", text: "Report downloaded — 214 rows", duration: "2m 46s", step: "Report run" },
  ],
  data: [{ step: "Report run", dir: "read", field: "Row count", value: "214", system: "kronos", ts: "4:33:19" }],
  receipt: {
    tone: "success",
    headline: "Done · report downloaded",
    lines: [
      { label: "Rows", value: "214", verified: true },
      { label: "Saved", value: "reports/2026-07-24-timecard-exceptions.xlsx" },
    ],
  },
  shots: [{ label: "Report page", kind: "step" }],
};

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const PRIOR_SPECS: DemoRowSpec[] = [sepVictor, ecNoor, wsTomas, sepLena, onbAmir, obPriyanka, krThursday];

const PRIOR_BY_ID = new Map(PRIOR_SPECS.map((r) => [r.id, r]));

/** the prior days' projected surfaces — same projection as today's corpus */
export const PRIOR_DAY_ROWS: Record<string, DemoRow> = Object.fromEntries(
  PRIOR_SPECS.map((spec) => [spec.id, projectRow(spec, PRIOR_BY_ID)]),
);

/**
 * Every row the tracker holds, across every day. Row lookups by id go through
 * this — a row selected from Wednesday must open in the log panel exactly like
 * a row selected from today.
 */
export const ALL_DEMO_ROWS: Record<string, DemoRow> = { ...DEMO_ROWS, ...PRIOR_DAY_ROWS };

/**
 * The ONE corpus function. Every count in the app is `countRows()` over what
 * this returns, so the date, the badges, the pills and the rows move together.
 */
export function topLevelRowsForDay(day: string): DemoRow[] {
  return Object.values(ALL_DEMO_ROWS).filter((r) => r.rowType !== "member" && dayOfRow(r) === day);
}

/** how many top-level rows each day holds — the date navigator's own badge */
export function dayCounts(): Record<string, number> {
  return Object.fromEntries(DEMO_DAYS.map((d) => [d, topLevelRowsForDay(d).length]));
}

// ---------------------------------------------------------------------------
// The month grid behind the date navigator's calendar
//
// It is pure and it is derived: a cell's COUNT is `topLevelRowsForDay`, the one
// corpus function every badge in the app already goes through, so the number in
// a calendar cell and the number the queue shows after pressing it are the same
// number by construction rather than by agreement.
//
// A day the tracker holds no partition for is rendered and DISABLED with its
// reason, never hidden: the queue is day-partitioned on disk, so "there is no
// file for Sunday" is a fact about the tracker, and a calendar that silently
// skips those days teaches the operator the month has holes in it.
// ---------------------------------------------------------------------------

export interface DemoCalendarCell {
  /** `YYYY-MM-DD` */
  day: string;
  dayOfMonth: number;
  /** false for the leading/trailing cells that belong to a neighbouring month */
  inMonth: boolean;
  /** rows the tracker holds on this day — the `topLevelRowsForDay` path */
  count: number;
  /** the tracker holds a partition for this day, so it can be selected */
  available: boolean;
  isToday: boolean;
}

/** `2026-07-25` → `2026-07` */
export function monthOfDay(day: string): string {
  return day.slice(0, 7);
}

/** `2026-07` → `July 2026` */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** `2026-07` shifted by whole months, staying a `YYYY-MM` */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** the months the tracker has partitions in, oldest first — the browsable range */
export function demoMonthRange(): { first: string; last: string } {
  return { first: monthOfDay(DEMO_DAYS[0]), last: monthOfDay(DEMO_DAYS[DEMO_DAYS.length - 1]) };
}

const MS_DAY = 86_400_000;

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Six Sunday-first weeks, always — 42 cells.
 *
 * A grid whose ROW COUNT changes with the month reflows the popover (and the
 * button under the pointer) every time you step a month, which is the one thing
 * a date picker must not do.
 */
export function buildDemoMonth(month: string): DemoCalendarCell[] {
  const [y, m] = month.split("-").map(Number);
  const first = Date.UTC(y, m - 1, 1);
  const start = first - new Date(first).getUTCDay() * MS_DAY;
  const held = new Set(DEMO_DAYS);
  const cells: DemoCalendarCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const ms = start + i * MS_DAY;
    const day = ymd(ms);
    const available = held.has(day);
    cells.push({
      day,
      dayOfMonth: new Date(ms).getUTCDate(),
      inMonth: day.slice(0, 7) === month,
      count: available ? topLevelRowsForDay(day).length : 0,
      available,
      isToday: day === DEMO_DAY,
    });
  }
  return cells;
}

/**
 * Arrow-key movement inside the grid, clamped to the 42 cells it holds.
 *
 * Pure so the keyboard contract is a test rather than a thing somebody checks
 * by pressing keys — and it is a CLAMP, not a wrap: running off the right edge
 * of the last week should stop, not teleport to the first.
 */
export function moveCalendarFocus(index: number, key: string): number | null {
  const delta =
    key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : key === "ArrowDown" ? 7 : key === "ArrowUp" ? -7 : null;
  if (delta === null) {
    if (key === "Home") return index - (index % 7);
    if (key === "End") return index - (index % 7) + 6;
    return null;
  }
  const next = index + delta;
  return next < 0 || next > 41 ? index : next;
}
