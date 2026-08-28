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
