import type { JSX } from "react";
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { NodeFrame } from "./NodeFrame.js";
import { opKindVisual } from "../op-kind-visuals.js";
import type { ActionGraphNode } from "../graph-types.js";

/**
 * A real automation primitive placed from the Data Bank — the "what gets clicked
 * / located / filled / scraped" detail. Header = the op kind (icon + verb); body
 * shows the target (selector role · accessible name) and the data flow (fills
 * from `{var}` / scrapes into `{var}`). Intent-only — it feeds the scaffold.
 */
function ActionNodeImpl({ data, selected }: NodeProps<ActionGraphNode>): JSX.Element {
  const v = opKindVisual(data.kind);
  const target = data.accessibleName
    ? `${data.role ?? "el"} · ${data.accessibleName}`
    : data.role ?? data.selectorFqn ?? data.url ?? "";
  return (
    <NodeFrame
      icon={v.icon}
      kind={v.verb}
      accentClass={v.accent}
      selected={selected}
      widthClass="w-56"
      hasTarget
      hasSource
    >
      <div className="space-y-1">
        <p className="min-w-0 truncate text-sm font-medium text-foreground" title={data.label}>
          {data.label}
        </p>
        <div className="flex items-center gap-1">
          <span className="shrink-0 rounded-sm border border-border bg-secondary/60 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
            {data.system}
          </span>
          {target ? (
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground" title={data.selectorFqn ?? target}>
              {target}
            </span>
          ) : null}
        </div>
        {data.inputVar ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-log-teal" title={`fills from ${data.inputVar}`}>
            <ArrowDownToLine aria-hidden className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono">{data.inputVar}</span>
          </span>
        ) : null}
        {data.outputVar ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-log-cyan" title={`scrapes into ${data.outputVar}`}>
            <ArrowUpFromLine aria-hidden className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono">{data.outputVar}</span>
          </span>
        ) : null}
      </div>
    </NodeFrame>
  );
}

export const ActionNode = memo(ActionNodeImpl);
