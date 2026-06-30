import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Box } from "lucide-react";
import { LaneShell } from "./LaneShell.js";
import { useLaneInteraction } from "../lane-interaction.js";
import { ROW_NODE_ID } from "../graph-build.js";
import type { StepGraphNode } from "../graph-types.js";

/**
 * A presentation step rendered as a LANE: the header carries the display config
 * (label / hidden / fold), the body nests the step's REAL mined ops. Collapse
 * state comes from the canvas interaction context (kept out of node data so a
 * draft edit doesn't reset it). Selecting the lane opens the inspector.
 */
function StepNodeImpl({ id, data, selected }: NodeProps<StepGraphNode>): JSX.Element {
  const { isCollapsed, toggleCollapsed, dryRun, removeAddedOp, dropTargetStep } = useLaneInteraction();
  const collapsed = isCollapsed(id);
  const eyebrow = data.stepIndex !== undefined ? `Step ${data.stepIndex + 1}` : "Step";
  return (
    <LaneShell
      icon={Box}
      eyebrow={eyebrow}
      title={data.label}
      ops={data.ops ?? []}
      addedOps={data.addedOps ?? []}
      onRemoveAddedOp={(addedId) => removeAddedOp(data.step, addedId)}
      isDropTarget={dropTargetStep === data.step}
      collapsed={collapsed}
      onToggleCollapse={() => toggleCollapsed(id)}
      selected={selected}
      modified={data.overrideRule !== undefined}
      hidden={data.hidden}
      foldInto={data.foldInto}
      foldedCount={data.foldedSteps.length}
      hasTarget
      hasSource
      dryRunOn={dryRun.on}
      dryRun={dryRun.forStep(data.step)}
    />
  );
}

export const StepNode = memo(StepNodeImpl);

// Re-export so the canvas can reference the row id without importing graph-build twice.
export { ROW_NODE_ID };
