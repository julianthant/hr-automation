import type {
  StartReplacementInputWire,
  StartTimelineWire,
} from "./demo-wire";

/** Every declared step starts selected: the ordinary path asks for no overrides. */
export function defaultSelectedSteps(timeline: StartTimelineWire | undefined): string[] {
  return timeline?.steps.map((step) => step.key) ?? [];
}

/**
 * Fold replacement inputs from skipped steps into one stable form. Two skipped
 * steps can require the same value (for example EID); the operator fills it
 * once, at the earliest point it becomes necessary.
 */
export function replacementInputsForSelection(
  timeline: StartTimelineWire | undefined,
  selectedSteps: readonly string[],
): StartReplacementInputWire[] {
  if (!timeline) return [];
  const selected = new Set(selectedSteps);
  const seen = new Set<string>();
  const inputs: StartReplacementInputWire[] = [];

  for (const step of timeline.steps) {
    if (selected.has(step.key)) continue;
    for (const input of step.replacementInputs ?? []) {
      if (seen.has(input.key)) continue;
      seen.add(input.key);
      inputs.push(input);
    }
  }

  return inputs;
}

export function missingReplacementInputs(
  inputs: readonly StartReplacementInputWire[],
  values: Readonly<Record<string, string>>,
): StartReplacementInputWire[] {
  return inputs.filter((input) => (values[input.key] ?? "").trim().length === 0);
}

export type RunStartCustomizationSection = "steps" | "values" | "options";

export interface RunStartStage {
  number: number;
  label: "Input" | "Steps" | "Values" | "Options" | "Confirm";
}

const CUSTOMIZATION_STAGE_LABEL: Record<RunStartCustomizationSection, RunStartStage["label"]> = {
  steps: "Steps",
  values: "Values",
  options: "Options",
};

/**
 * Progressive launcher sections, in causal order. The default form has none:
 * steps appear only when the operator opts out of the workflow defaults,
 * values appear only when a skipped step needs replacements, and options
 * appear only when the operator opts out of their defaults.
 */
export function runStartCustomizationSections({
  timeline,
  defaultSteps,
  defaultOptions,
  selectedSteps,
}: {
  timeline: StartTimelineWire | undefined;
  defaultSteps: boolean;
  defaultOptions: boolean;
  selectedSteps: readonly string[];
}): RunStartCustomizationSection[] {
  const sections: RunStartCustomizationSection[] = [];
  if (timeline && !defaultSteps) {
    sections.push("steps");
    if (replacementInputsForSelection(timeline, selectedSteps).length > 0) sections.push("values");
  }
  if (!defaultOptions) sections.push("options");
  return sections;
}

/**
 * The compact launch path is a real wizard. Input never moves, opt-in
 * customization follows in causal order, and Confirm is always the terminal
 * step where the consequential command lives.
 */
export function runStartStages(sections: readonly RunStartCustomizationSection[]): RunStartStage[] {
  return [
    { number: 1, label: "Input" },
    ...sections.map((section, index) => ({ number: index + 2, label: CUSTOMIZATION_STAGE_LABEL[section] })),
    { number: sections.length + 2, label: "Confirm" },
  ];
}

export function adjacentRunStartStage(
  stages: readonly RunStartStage[],
  current: RunStartStage["label"],
  direction: "previous" | "next",
): RunStartStage["label"] | null {
  const currentIndex = stages.findIndex((stage) => stage.label === current);
  if (currentIndex < 0) return null;
  return stages[currentIndex + (direction === "next" ? 1 : -1)]?.label ?? null;
}

const RUN_START_STAGE_ORDER: readonly RunStartStage["label"][] = [
  "Input",
  "Steps",
  "Values",
  "Options",
  "Confirm",
];

/**
 * A dynamic stage can disappear while the gear menu is open. Keep the wizard
 * on the nearest still-present earlier step instead of stranding it on a page
 * that no longer exists.
 */
export function reconcileRunStartStage(
  stages: readonly RunStartStage[],
  current: RunStartStage["label"],
): RunStartStage["label"] {
  if (stages.some((stage) => stage.label === current)) return current;
  const currentIndex = RUN_START_STAGE_ORDER.indexOf(current);
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const candidate = RUN_START_STAGE_ORDER[index];
    if (stages.some((stage) => stage.label === candidate)) return candidate;
  }
  return "Input";
}
