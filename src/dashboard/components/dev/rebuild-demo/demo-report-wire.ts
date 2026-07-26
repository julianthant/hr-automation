/**
 * DEV-ONLY — the ACTIVITY REPORT's wire shapes.
 *
 * `demo-feature-plan-2026-07-25.md` §1.6 (Activity report) / §6 #8, M2: "runs /
 * people / error-rate / hours-saved over spans + ledger (supervisor demo)".
 * The format was an open decision; this is the demo's answer to it.
 *
 * A supervisor-facing artifact is exactly where a tool starts lying, so three
 * rules are baked into the shape rather than left to the copy:
 *
 *  1. **Every count is derived from the SAME corpus and the SAME
 *     `effectiveStatus` the queue reads.** The report cannot claim a number the
 *     dashboard would contradict, because there is no second tally.
 *  2. **Hours saved is a typed ESTIMATE, not a measurement.** The per-workflow
 *     minutes are an operator-entered constant, carried with their provenance
 *     and rendered as such. Failed runs are excluded from the total — a run
 *     that broke cost time, it did not save any.
 *  3. **Non-terminal work is never counted as done.** Queued / running /
 *     waiting / parked rows are reported separately as OUTSTANDING, so a busy
 *     week cannot read as a finished one.
 */

import type { ProposedStatus } from "./demo-status";
import type { DemoRow } from "./demo-data";
import { effectiveStatus } from "./demo-data";
import { ALL_DEMO_ROWS, DEMO_DAYS, dayLabel, dayOfRow, topLevelRowsForDay } from "./demo-days";
import { DEMO_WORKFLOWS, type DemoWorkflowId } from "./demo-wire";
import { DEMO_ARCHIVE, isTerminal } from "./demo-archive-wire";

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

export interface ReportSpan {
  key: string;
  label: string;
  days: string[];
}

export const REPORT_SPANS: ReportSpan[] = [
  { key: "today", label: dayLabel(DEMO_DAYS[DEMO_DAYS.length - 1]), days: [DEMO_DAYS[DEMO_DAYS.length - 1]] },
  { key: "all", label: `Every day the tracker holds (${DEMO_DAYS.length})`, days: DEMO_DAYS },
];

// ---------------------------------------------------------------------------
// The one operator-entered number in the whole report
// ---------------------------------------------------------------------------

/**
 * Minutes the operator says one run of each workflow takes by hand. **This is
 * the only figure in the report that is not measured**, which is why it lives
 * in one named constant with its provenance attached instead of being folded
 * invisibly into a total.
 */
export const MANUAL_MINUTES: Record<DemoWorkflowId, number> = {
  separations: 22,
  onboarding: 35,
  "person-lookup": 4,
  "person-match": 3,
  "work-study": 6,
  "kronos-pay-rule": 8,
  ocr: 15,
  "oath-signature": 5,
  "oath-upload": 12,
  "emergency-contact": 7,
  onbase: 10,
  "i9-check": 6,
  "crm-doc-download": 3,
  "kronos-reports": 20,
};

export const MANUAL_MINUTES_PROVENANCE =
  "an operator-maintained minutes-per-run figure for each workflow. It is not measured anywhere, and the report says so every place it is used rather than once in a footnote.";

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface WorkflowLine {
  workflowId: DemoWorkflowId;
  label: string;
  code: string;
  runs: number;
  verified: number;
  warnings: number;
  failed: number;
  cancelled: number;
  outstanding: number;
  /** minutes saved = completed (verified + warnings) × the operator's estimate */
  minutesSaved: number;
}

export interface LedgerLine {
  system: string;
  entries: number;
  prod: number;
  test: number;
}

export interface ActivityReport {
  span: ReportSpan;
  generatedAt: string;
  totals: {
    runs: number;
    verified: number;
    warnings: number;
    failed: number;
    cancelled: number;
    outstanding: number;
    /** distinct people touched — by EID, so one person in two runs counts once */
    people: number;
  };
  /** failed ÷ terminal, as a percentage. Non-terminal rows are excluded. */
  errorRatePct: number;
  byWorkflow: WorkflowLine[];
  hoursSaved: number;
  ledger: LedgerLine[];
  caveats: string[];
}

type CountBucket = "verified" | "warnings" | "failed" | "cancelled" | "outstanding";

function statusBucket(status: ProposedStatus): CountBucket {
  if (status === "verifiedDone") return "verified";
  if (status === "doneWarnings") return "warnings";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "outstanding";
}

/**
 * Distinct people in the span, counted over EVERY row including members —
 * a 50-person I-9 roster is 50 people, not one. A row with no EID is not a
 * person and is not counted as one.
 */
function distinctPeople(days: Set<string>): number {
  const eids = new Set<string>();
  for (const row of Object.values(ALL_DEMO_ROWS)) {
    if (!days.has(dayOfRow(row))) continue;
    if (row.eid) eids.add(row.eid);
  }
  return eids.size;
}

export function buildActivityReport(span: ReportSpan, generatedAt: string): ActivityReport {
  const days = new Set(span.days);
  const rows: DemoRow[] = span.days.flatMap((day) => topLevelRowsForDay(day));

  const totals = { runs: 0, verified: 0, warnings: 0, failed: 0, cancelled: 0, outstanding: 0, people: 0 };
  const perWorkflow = new Map<DemoWorkflowId, WorkflowLine>();

  for (const row of rows) {
    const id = row.workflow.id;
    const line =
      perWorkflow.get(id) ??
      ({
        workflowId: id,
        label: row.workflow.label,
        code: row.workflow.code,
        runs: 0,
        verified: 0,
        warnings: 0,
        failed: 0,
        cancelled: 0,
        outstanding: 0,
        minutesSaved: 0,
      } satisfies WorkflowLine);

    const bucket = statusBucket(effectiveStatus(row));
    line.runs += 1;
    totals.runs += 1;
    line[bucket] += 1;
    totals[bucket] += 1;
    perWorkflow.set(id, line);
  }

  for (const line of perWorkflow.values()) {
    // Only work that actually FINISHED saved anything. A failed run cost time.
    line.minutesSaved = (line.verified + line.warnings) * MANUAL_MINUTES[line.workflowId];
  }

  totals.people = distinctPeople(days);

  const terminal = totals.verified + totals.warnings + totals.failed + totals.cancelled;
  const errorRatePct = terminal === 0 ? 0 : Math.round((totals.failed / terminal) * 1000) / 10;

  const byWorkflow = [...perWorkflow.values()].sort((a, b) => b.runs - a.runs);
  const minutes = byWorkflow.reduce((n, line) => n + line.minutesSaved, 0);

  // The ledger is never pruned and never archived, so it is the only block here
  // that reaches back past the span's own rows.
  const ledgerMap = new Map<string, LedgerLine>();
  for (const run of DEMO_ARCHIVE) {
    for (const entry of run.ledger) {
      const line = ledgerMap.get(entry.system) ?? { system: entry.system, entries: 0, prod: 0, test: 0 };
      line.entries += 1;
      if (entry.instance === "prod") line.prod += 1;
      else line.test += 1;
      ledgerMap.set(entry.system, line);
    }
  }

  return {
    span,
    generatedAt,
    totals,
    errorRatePct,
    byWorkflow,
    hoursSaved: Math.round((minutes / 60) * 10) / 10,
    ledger: [...ledgerMap.values()].sort((a, b) => b.entries - a.entries),
    caveats: [
      `Hours saved is an ESTIMATE — ${MANUAL_MINUTES_PROVENANCE} It multiplies the operator's per-workflow minutes by the runs that actually finished — failed and cancelled runs contribute nothing, because a run that broke cost time rather than saving it.`,
      "Error rate counts only runs that reached a terminal state. Anything queued, running, waiting on you or parked is excluded and reported separately as outstanding, so a busy day cannot read as a finished one.",
      `${totals.outstanding} run${totals.outstanding === 1 ? " is" : "s are"} still outstanding in this span. That work is not represented in hours saved.`,
      "People are counted by EID across every row including group members, so one person appearing in two runs counts once and a 50-person roster counts as 50.",
      "Ledger entries are what was actually filed in a real HR system. They are never pruned and never archived, which is why they can outlive the runs that filed them.",
    ],
  };
}

/** the report's own view of what is still open — the honest counterweight */
export function outstandingRows(span: ReportSpan): DemoRow[] {
  return span.days.flatMap((day) => topLevelRowsForDay(day)).filter((row) => !isTerminal(effectiveStatus(row)));
}

export function workflowLabel(id: DemoWorkflowId): string {
  return DEMO_WORKFLOWS[id].label;
}
