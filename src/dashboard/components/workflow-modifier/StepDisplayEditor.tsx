import { ChevronDown, ChevronUp } from "lucide-react";
import type {
  StepDisplayConfig,
  StepDisplayRule,
} from "../../../domain/workflow-presentation/types.js";
import { formatStepName } from "../shared/types.js";
import type { WorkflowPresentationDetail, WorkflowOverride } from "./useWorkflowPresentation.js";

interface Props {
  data: WorkflowPresentationDetail;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
}

export function StepDisplayEditor({ data, draft, onChange }: Props): JSX.Element {
  const cfg: StepDisplayConfig = draft.presentation?.steps ?? data.effective.presentation?.steps ?? {};
  const order: string[] = cfg.order ?? [...data.base.steps];

  const setBlock = (value: StepDisplayConfig) =>
    onChange({ ...draft, presentation: { ...(draft.presentation ?? {}), steps: value } });

  const ruleFor = (step: string): StepDisplayRule =>
    (cfg.rules ?? []).find((r) => r.step === step) ?? { step };

  const updateRule = (step: string, patch: Partial<StepDisplayRule>) => {
    const existing = ruleFor(step);
    const merged: StepDisplayRule = { ...existing, ...patch };
    // Prune falsy/empty overrides so a fully-default rule collapses to { step }
    if (!merged.hidden) delete merged.hidden;
    if (!merged.label) delete merged.label;
    if (!merged.foldInto) delete merged.foldInto;
    const meaningful = Object.keys(merged).some((k) => k !== "step");
    const filtered = (cfg.rules ?? []).filter((r) => r.step !== step);
    const rules = meaningful ? [...filtered, merged] : filtered;
    setBlock({ ...cfg, rules: rules.length ? rules : undefined });
  };

  const moveStep = (index: number, direction: "up" | "down") => {
    const newOrder = [...order];
    const swapWith = direction === "up" ? index - 1 : index + 1;
    [newOrder[index], newOrder[swapWith]] = [newOrder[swapWith], newOrder[index]];
    setBlock({ ...cfg, order: newOrder });
  };

  return (
    <section className="rounded-md border border-border p-4">
      <h3 className="text-sm font-semibold mb-3">Step Display</h3>
      <div className="space-y-2">
        {order.map((step, idx) => {
          const rule = ruleFor(step);
          const otherSteps = order.filter((s) => s !== step);
          return (
            <div
              key={step}
              className="rounded border border-border bg-secondary/30 px-3 py-2 flex flex-col gap-2"
            >
              {/* Header row: step id + reorder buttons */}
              <div className="flex items-center gap-2">
                <span className="flex-1 text-xs font-mono text-muted-foreground truncate">{step}</span>
                <button
                  type="button"
                  aria-label={`move ${step} up`}
                  disabled={idx === 0}
                  onClick={() => moveStep(idx, "up")}
                  className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronUp className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`move ${step} down`}
                  disabled={idx === order.length - 1}
                  onClick={() => moveStep(idx, "down")}
                  className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </button>
              </div>
              {/* Controls row */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {/* Hidden checkbox */}
                <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rule.hidden ?? false}
                    onChange={(e) => updateRule(step, { hidden: e.target.checked || undefined })}
                    className="rounded border border-border bg-background"
                  />
                  Hide
                </label>
                {/* Label override */}
                <div className="flex items-center gap-1.5">
                  <label
                    htmlFor={`step-label-${step}`}
                    className="text-xs text-muted-foreground whitespace-nowrap"
                  >
                    Label
                  </label>
                  <input
                    id={`step-label-${step}`}
                    type="text"
                    value={rule.label ?? ""}
                    placeholder={formatStepName(step)}
                    onChange={(e) => updateRule(step, { label: e.target.value || undefined })}
                    className="border border-border rounded px-2 py-0.5 text-xs bg-background text-foreground w-36"
                  />
                </div>
                {/* foldInto select */}
                <div className="flex items-center gap-1.5">
                  <label
                    htmlFor={`step-fold-${step}`}
                    className="text-xs text-muted-foreground whitespace-nowrap"
                  >
                    Fold into
                  </label>
                  <select
                    id={`step-fold-${step}`}
                    value={rule.foldInto ?? ""}
                    onChange={(e) => updateRule(step, { foldInto: e.target.value || undefined })}
                    className="border border-border rounded px-2 py-0.5 text-xs bg-background text-foreground"
                  >
                    <option value="">— none —</option>
                    {otherSteps.map((s) => (
                      <option key={s} value={s}>
                        {formatStepName(s)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
