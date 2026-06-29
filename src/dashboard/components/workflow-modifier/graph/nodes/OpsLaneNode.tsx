import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Workflow } from "lucide-react";
import { LaneShell } from "./LaneShell.js";
import { useLaneInteraction } from "../lane-interaction.js";
import type { OpsLaneGraphNode } from "../graph-types.js";

/**
 * A display-only lane for mined ops that map to NO presentation step. Same lane
 * chrome, but read-only (no presentation config rides it, and the override
 * projection ignores it). Keeps "show every op" honest when the automation has a
 * phase the presentation pipeline doesn't name.
 */
function OpsLaneNodeImpl({ id, data, selected }: NodeProps<OpsLaneGraphNode>): JSX.Element {
  const { isCollapsed, toggleCollapsed, dryRun } = useLaneInteraction();
  return (
    <LaneShell
      icon={Workflow}
      eyebrow="Ops"
      title={data.label}
      ops={data.ops}
      collapsed={isCollapsed(id)}
      onToggleCollapse={() => toggleCollapsed(id)}
      selected={selected}
      accentClass="text-log-violet"
      hasTarget
      hasSource
      dryRunOn={dryRun.on}
      dryRun={dryRun.forStep(data.step)}
      badge={
        <span className="rounded-full border border-border bg-secondary px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
          read-only
        </span>
      }
    />
  );
}

export const OpsLaneNode = memo(OpsLaneNodeImpl);
