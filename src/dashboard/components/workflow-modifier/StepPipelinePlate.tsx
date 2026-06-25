import { useState } from "react";
import { ArrowRight, RotateCcw } from "lucide-react";
import type { StepDisplayRule } from "../../../domain/workflow-presentation/types.js";
import type { WorkflowPresentationDetail, WorkflowOverride } from "./useWorkflowPresentation.js";
import { formatStepName } from "../shared/types.js";
import { StepChip, type StepChipModel } from "./StepChip.js";
import {
  moveInOrder,
  setStepOrder,
  resetStepOrder,
  updateStepRule,
  resetStepRule,
} from "./blueprint-helpers.js";

interface Props {
  data: WorkflowPresentationDetail;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
}

/**
 * Plate ②. The workflow's step timeline as a draggable chip rail. Each chip is
 * its own editor (rename / hide / fold). Drag reorders; the chevrons are the
 * keyboard-accessible reorder path.
 */
export function StepPipelinePlate({ data, draft, onChange }: Props): JSX.Element {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const order = draft.presentation?.steps?.order ?? [...data.base.steps];
  const draftRules = draft.presentation?.steps?.rules ?? [];
  const baseRules = data.base.presentation?.steps?.rules ?? [];
  const orderModified = draft.presentation?.steps?.order !== undefined;

  const ruleFor = (step: string): StepDisplayRule =>
    draftRules.find((r) => r.step === step) ??
    baseRules.find((r) => r.step === step) ?? { step };

  const labelFor = (step: string): string => ruleFor(step).label ?? formatStepName(step);

  const foldCounts = new Map<string, number>();
  for (const step of order) {
    const target = ruleFor(step).foldInto;
    if (target) foldCounts.set(target, (foldCounts.get(target) ?? 0) + 1);
  }

  const finishDrag = (dropIndex: number | null) => {
    if (draggingIndex !== null && dropIndex !== null && draggingIndex !== dropIndex) {
      onChange(setStepOrder(draft, moveInOrder(order, draggingIndex, dropIndex)));
    }
    setDraggingIndex(null);
    setDragOverIndex(null);
  };

  if (order.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">This workflow declares no steps.</p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-[11px] text-muted-foreground">
          Drag to reorder, or click a step to rename, hide, or fold it.
        </p>
        {orderModified ? (
          <button
            type="button"
            onClick={() => onChange(resetStepOrder(draft))}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-primary outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            <RotateCcw aria-hidden className="h-3 w-3 shrink-0" />
            Reset order
          </button>
        ) : null}
      </div>

      <ol className="flex flex-wrap items-center gap-y-2">
        {order.map((step, idx) => {
          const rule = ruleFor(step);
          const model: StepChipModel = {
            step,
            label: labelFor(step),
            hidden: rule.hidden ?? false,
            foldInto: rule.foldInto,
            foldCount: foldCounts.get(step) ?? 0,
            modified: draftRules.some((r) => r.step === step),
          };
          const foldTargets = order
            .filter((s) => s !== step)
            .map((s) => ({ id: s, label: labelFor(s) }));

          return (
            <li key={step} className="flex items-center">
              <StepChip
                model={model}
                index={idx}
                total={order.length}
                foldTargets={foldTargets}
                hostLabel={rule.foldInto ? labelFor(rule.foldInto) : undefined}
                isDragging={draggingIndex === idx}
                isDragOver={dragOverIndex === idx && draggingIndex !== idx}
                onRename={(label) => onChange(updateStepRule(draft, step, { label }))}
                onFold={(target) => onChange(updateStepRule(draft, step, { foldInto: target }))}
                onToggleHidden={(hidden) => onChange(updateStepRule(draft, step, { hidden }))}
                onMove={(dir) =>
                  onChange(setStepOrder(draft, moveInOrder(order, idx, dir === "up" ? idx - 1 : idx + 1)))
                }
                onReset={() => onChange(resetStepRule(draft, step))}
                onDragStart={() => setDraggingIndex(idx)}
                onDragEnter={() => setDragOverIndex(idx)}
                onDrop={() => finishDrag(idx)}
                onDragEnd={() => finishDrag(dragOverIndex)}
              />
              {idx < order.length - 1 ? (
                <ArrowRight aria-hidden className="mx-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
