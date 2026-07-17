import type { JSX } from "react";
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { CircleDot, Rows3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { NodeFrame } from "./NodeFrame.js";
import type { RowGraphNode } from "../graph-types.js";
import { previewTitle, previewSubtitle, previewTrace } from "../../blueprint-helpers.js";

function RowNodeImpl({ data, selected }: NodeProps<RowGraphNode>): JSX.Element {
  const title = previewTitle(data.sampleVars, data.title);
  const subtitle = previewSubtitle(data.sampleVars, data.subtitle);
  const trace = previewTrace(data.sampleVars, data.trace);
  const titleModified = data.titleOverride !== undefined;
  const subtitleModified = data.subtitleOverride !== undefined;
  const traceModified = data.traceOverride !== undefined;

  return (
    <NodeFrame
      icon={Rows3}
      kind="Queue row"
      selected={selected}
      modified={titleModified || subtitleModified || traceModified}
      widthClass="w-64"
      hasSource
    >
      <div className="space-y-1.5">
        <PartLine modified={titleModified}>
          {title ? (
            <span className="text-sm font-medium text-foreground">{title}</span>
          ) : (
            <span className="text-sm italic text-muted-foreground">(no title)</span>
          )}
        </PartLine>
        <PartLine modified={subtitleModified}>
          <span className="font-mono text-xs text-muted-foreground">{subtitle || "—"}</span>
        </PartLine>
        <div className="flex items-center gap-1.5 border-t border-border/60 pt-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">trace</span>
          {traceModified ? (
            <CircleDot aria-hidden className="h-2.5 w-2.5 shrink-0 text-primary" />
          ) : null}
          <span className="truncate font-mono text-[11px] text-muted-foreground">{trace}</span>
        </div>
      </div>
    </NodeFrame>
  );
}

function PartLine({
  modified,
  children,
}: {
  modified: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className={cn("flex items-center gap-1.5", modified && "min-w-0")}>
      {modified ? <CircleDot aria-hidden className="h-2.5 w-2.5 shrink-0 text-primary" /> : null}
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

export const RowNode = memo(RowNodeImpl);
