// Dry-run diff classifier — the pure seam behind the Workflow Editor's "Dry run"
// overlay. Given a workflow's mined Data Bank, it derives WHERE a dry run diverges
// from a normal (live) run, so the graph can annotate the difference without the
// operator reading code.
//
// It invents nothing: every classification reads a signal the miners already put
// in the bank —
//   • a `control` op that branches on dryRun (e.g. `control.dryRun#control`,
//     label "Gate: skip Save if dryRun mode") → the GATE (the decision point);
//   • an op whose `note` marks it live-only ("!dryRun", "Live runs only",
//     "dry-run terminal exits before this") → SKIPPED under dry run;
//   • a step `note` saying the whole step is skipped on dryRun → a skipped step;
//   • the workflow-level "Dry-run boundary: …" note → the verbatim boundary text
//     (and "No dry-run boundary: …" → the workflow has no dry-run mode).
//
// Pure + client-safe (no node imports): the dashboard overlay and any future
// design tooling consume it, and it is the testable seam (no component harness).

import type { WorkflowDataBank, DataBankOperation } from "./data-bank.js";

/** What a single op does differently under a dry run. */
export type DryRunOpEffect =
  | "gate" // the control op that branches on dryRun (the decision point)
  | "skip"; // does NOT execute under dry run (live-only)

/** A step's role in the dry-run path. */
export type DryRunStepEffect =
  | "gate" // contains the dry-run gate — execution branches / returns early here
  | "skip" // the whole step is skipped under dry run
  | "partial"; // the step still runs, but some of its ops are skipped

export interface DryRunStepDiff {
  /** Step id — matches `DataBankStep.step` (the presentation step id where mapped). */
  step: string;
  effect: DryRunStepEffect;
  /** Per-op effect within the step, keyed by op id (first occurrence wins). */
  opEffects: Record<string, DryRunOpEffect>;
  /** Human explanation — the gate op's summary, else the step note. */
  reason?: string;
}

export interface WorkflowDryRunDiff {
  /** True when the workflow has a dry-run mode at all (false → toggle shows nothing). */
  hasDryRun: boolean;
  /** The "Dry-run boundary: …" note, label prefix stripped. The authoritative,
   *  always-honest summary shown as the overlay banner. */
  boundary?: string;
  /** Steps that differ under dry run, keyed by step id (only divergent steps). */
  steps: Record<string, DryRunStepDiff>;
  /** The step id holding the dry-run gate, when one is structurally identifiable
   *  (a `control` op). Absent for workflows whose boundary is prose-only (e.g.
   *  separations gates inside a step transition, not a single control op). */
  gateStep?: string;
}

const DRY_RUN = /dry[\s-]?run/i;

/** A `control` op that IS the dry-run branch/gate. The reliable signal is the op
 *  ID SLUG (`control.dryRun#control`, `control.dryRunGate#control`,
 *  `control.dry-run-gate#control`, `control.dryRunBranch#control`) — a control op
 *  named for the dryRun decision. We deliberately do NOT key on the label/summary:
 *  ops that merely RUN on the `!dryRun` branch (a duplicate-guard, a modal-mask
 *  dismiss) mention dryRun in their prose but are skip-candidates, not the gate. */
function isGateOp(op: DataBankOperation): boolean {
  return op.kind === "control" && DRY_RUN.test(op.id);
}

/** An op explicitly NOT executed under dry run (live-only), per its `note`. */
function isSkipOp(op: DataBankOperation): boolean {
  const note = op.note ?? "";
  if (!DRY_RUN.test(note)) return false;
  return (
    /!\s*dry[\s-]?run/i.test(note) || // "!dryRun"
    /\blive runs?\b[^.]*\bonly\b/i.test(note) || // "Live runs only"
    /\bonly\b[^.]*\blive runs?\b/i.test(note) ||
    /dry[\s-]?run terminal exits before this/i.test(note) ||
    /\bskip(?:s|ped)?\b[^.]*\bif dry[\s-]?run/i.test(note) || // "skip submit if dryRun"
    /\bon dry[\s-]?run\b[^.]*\bskip(?:s|ped)?\b/i.test(note) // "On dryRun, … is skipped"
  );
}

/** A step note saying the WHOLE step is skipped under dry run. Conservative — the
 *  per-op + boundary signals carry the detail; this only catches the clear cases. */
function stepNoteSaysSkip(note: string | undefined): boolean {
  if (!note || !DRY_RUN.test(note)) return false;
  return (
    /\bskipped\b[^.]*\bon\b[^.]*dry[\s-]?run/i.test(note) || // "Skipped on: dryRun"
    /\bon dry[\s-]?run\b[^.]*\bskip(?:s|ped)?\b/i.test(note) // "On dryRun, save is skipped"
  );
}

/** Scan the workflow notes for the boundary statement. Returns the boundary text
 *  (positive) and whether a "No dry-run boundary" note was seen (negative). */
function scanBoundary(notes: string[] | undefined): { boundary?: string; negative: boolean } {
  let negative = false;
  for (const n of notes ?? []) {
    if (/^\s*no\s+dry[\s-]?run\s+boundary/i.test(n)) {
      negative = true;
      continue;
    }
    const m = n.match(/^\s*dry[\s-]?run\s+boundary\s*[:\-—]?\s*(.*)$/is);
    if (m) return { boundary: (m[1].trim() || n.trim()), negative };
  }
  return { negative };
}

/**
 * Classify how a workflow's dry run diverges from its live run, reading only
 * signals the Data Bank already records. A gate op wins over a skip mark on the
 * same op; a step with a gate op is a `gate` step; a step the note flags as skipped
 * is `skip`; a step with only some ops skipped is `partial`. `hasDryRun` is true
 * when there is any divergent step or a positive boundary note, unless the workflow
 * explicitly declares "No dry-run boundary" with no other signal.
 */
export function deriveWorkflowDryRunDiff(bank: WorkflowDataBank | undefined): WorkflowDryRunDiff {
  if (!bank) return { hasDryRun: false, steps: {} };

  const steps: Record<string, DryRunStepDiff> = {};
  let gateStep: string | undefined;

  for (const step of bank.steps) {
    const opEffects: Record<string, DryRunOpEffect> = {};
    let hasGate = false;
    let gateReason: string | undefined;

    for (const op of step.operations) {
      if (isGateOp(op)) {
        opEffects[op.id] = "gate";
        hasGate = true;
        gateReason ??= op.summary ?? op.label;
      } else if (isSkipOp(op) && opEffects[op.id] !== "gate") {
        opEffects[op.id] = "skip";
      }
    }

    const hasSkipOp = Object.values(opEffects).some((e) => e === "skip");
    let effect: DryRunStepEffect | undefined;
    let reason: string | undefined;

    if (hasGate) {
      effect = "gate";
      reason = gateReason ?? step.note;
      gateStep ??= step.step;
    } else if (stepNoteSaysSkip(step.note)) {
      effect = "skip";
      reason = step.note;
    } else if (hasSkipOp) {
      effect = "partial";
      reason = step.note;
    }

    if (effect) steps[step.step] = { step: step.step, effect, opEffects, reason };
  }

  const { boundary, negative } = scanBoundary(bank.notes);
  const hasSignal = Object.keys(steps).length > 0 || boundary !== undefined;
  const hasDryRun = hasSignal && !(negative && Object.keys(steps).length === 0);

  return { hasDryRun, boundary, steps, gateStep };
}
