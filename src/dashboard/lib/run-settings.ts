/**
 * Shared run-settings choices for the dashboard's run launchers — the
 * Automation-workers selector used by both the input-run gear
 * (`RunSettingsMenu`) and the upload modal (`RunModal`).
 *
 * Backend contract lives in `src/domain/run-options.ts`: Auto (the default)
 * sends no `parallelWorkers`, so the daemon layer reuses an existing worker or
 * spawns one; an explicit N sends `parallelWorkers: N`, which raises the
 * alive-daemon target to ≥N for the run's downstream fan-out.
 */

/**
 * A workflow-declared run-mode preset (a named set of handler steps to skip).
 * Surfaced in the input-run settings gear (`RunSettingsMenu`) alongside the
 * Automation-workers picker. The implicit `"full"` entry (no skips) is
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

export const AUTO_WORKERS = "auto";

export type WorkerChoice = typeof AUTO_WORKERS | "1" | "2" | "4" | "6" | "8";

/** Operator-facing worker choices, in display order. Auto first (the default). */
export const WORKER_CHOICES: readonly WorkerChoice[] = [AUTO_WORKERS, "1", "2", "4", "6", "8"];

export function isAutoWorkers(choice: WorkerChoice): boolean {
  return choice === AUTO_WORKERS;
}

/** The value to POST / append as `parallelWorkers`; `undefined` for Auto. */
export function workerChoiceToParam(choice: WorkerChoice): number | undefined {
  return choice === AUTO_WORKERS ? undefined : Number(choice);
}

export function workerChoiceLabel(choice: WorkerChoice): string {
  return choice === AUTO_WORKERS ? "Auto" : choice;
}

export function workerChoiceDescription(choice: WorkerChoice): string {
  if (choice === AUTO_WORKERS) return "Reuse existing workers; start one if needed.";
  if (choice === "1") return "Ensure at least 1 worker is running.";
  return `Ensure at least ${choice} workers are running.`;
}
