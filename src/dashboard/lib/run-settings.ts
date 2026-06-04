/**
 * Shared run-settings vocabulary for the dashboard's run launchers — the
 * Automation-workers stepper used by both the input-run gear
 * (`RunSettingsMenu`) and the upload modal (`RunModal`), plus the run-mode
 * preset types those surfaces also carry.
 *
 * Backend contract lives in `src/domain/run-options.ts`: Auto (the default)
 * sends no `parallelWorkers`, so the daemon layer reuses an existing worker or
 * spawns one; an explicit N sends `parallelWorkers: N`, raising the
 * alive-daemon target to ≥N for the run's downstream fan-out.
 */

/**
 * A workflow-declared run-mode preset (a named set of handler steps to skip).
 * Surfaced in the input-run settings gear (`RunSettingsMenu`) alongside the
 * Automation-workers stepper. The implicit `"full"` entry (no skips) is
 * synthesized by the menu and is not part of a workflow's declared list.
 */
export interface StepPreset {
  id: string;
  label: string;
  skipSteps: string[];
  description?: string;
}

/** The synthetic "no skips" preset id (the default run mode). */
export const FULL_PRESET_ID = "full";

/** Auto = reuse-or-spawn-one (the default). Modeled as worker count 0. */
export const AUTO_WORKERS = "auto";

/** Max explicit worker count — mirrors `MAX_PARALLEL_WORKERS` in src/domain/run-options.ts. */
export const MAX_WORKERS = 8;

export type WorkerChoice =
  | typeof AUTO_WORKERS
  | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";

/** Numeric view of a choice; Auto = 0 so the stepper math is plain integers. */
function choiceToNum(choice: WorkerChoice): number {
  return choice === AUTO_WORKERS ? 0 : Number(choice);
}

/** Inverse of {@link choiceToNum}, clamped to [Auto, MAX_WORKERS]. */
function numToChoice(n: number): WorkerChoice {
  if (n <= 0) return AUTO_WORKERS;
  return String(Math.min(n, MAX_WORKERS)) as WorkerChoice;
}

/** One step down (… 2 → 1 → Auto). Auto is the floor. */
export function decWorkerChoice(choice: WorkerChoice): WorkerChoice {
  return numToChoice(choiceToNum(choice) - 1);
}

/** One step up (Auto → 1 → 2 …). {@link MAX_WORKERS} is the ceiling. */
export function incWorkerChoice(choice: WorkerChoice): WorkerChoice {
  return numToChoice(choiceToNum(choice) + 1);
}

export function canDecWorkerChoice(choice: WorkerChoice): boolean {
  return choiceToNum(choice) > 0;
}

export function canIncWorkerChoice(choice: WorkerChoice): boolean {
  return choiceToNum(choice) < MAX_WORKERS;
}

export function isAutoWorkers(choice: WorkerChoice): boolean {
  return choice === AUTO_WORKERS;
}

/** The value to POST / append as `parallelWorkers`; `undefined` for Auto. */
export function workerChoiceToParam(choice: WorkerChoice): number | undefined {
  return choice === AUTO_WORKERS ? undefined : Number(choice);
}

/** Display string for the stepper's value cell. */
export function workerChoiceLabel(choice: WorkerChoice): string {
  return choice === AUTO_WORKERS ? "Auto" : choice;
}

/** Screen-reader value text for the spinbutton-style control. */
export function workerChoiceValueText(choice: WorkerChoice): string {
  if (choice === AUTO_WORKERS) return "Auto — reuse a worker, start one if needed";
  return `${choice} worker${choice === "1" ? "" : "s"}`;
}
