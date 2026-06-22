import type { StepDisplayConfig } from "./types.js";

export interface DisplayStep {
  step: string;
  label: string;
  /** Step ids folded into this chip (rendered as part of it, generalizes OCR folding). */
  foldedSteps: string[];
}

/** "awaiting-approval" → "Awaiting Approval"; "auth:ucpath" → "Auth: Ucpath". */
export function formatStepLabel(step: string): string {
  return step
    .split(/[:_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(step.includes(":") ? ": " : " ")
    .replace(/: /, ": "); // keep the auth: separator readable
}

export function applyStepDisplay(steps: string[], config?: StepDisplayConfig): DisplayStep[] {
  const rules = new Map((config?.rules ?? []).map((r) => [r.step, r]));

  // 1. ordering
  let ordered = steps;
  if (config?.order && config.order.length) {
    const listed = config.order.filter((s) => steps.includes(s));
    const rest = steps.filter((s) => !listed.includes(s));
    ordered = [...listed, ...rest];
  }

  // 2. compute folds: map folded step -> target
  const foldTargets = new Map<string, string[]>();
  for (const s of ordered) {
    const r = rules.get(s);
    if (r?.foldInto) {
      const arr = foldTargets.get(r.foldInto) ?? [];
      arr.push(s);
      foldTargets.set(r.foldInto, arr);
    }
  }

  // 3. build display list — drop hidden + folded-away steps
  const out: DisplayStep[] = [];
  for (const s of ordered) {
    const r = rules.get(s);
    if (r?.hidden) continue;
    if (r?.foldInto) continue; // absorbed into its target
    out.push({ step: s, label: r?.label ?? formatStepLabel(s), foldedSteps: foldTargets.get(s) ?? [] });
  }
  return out;
}
