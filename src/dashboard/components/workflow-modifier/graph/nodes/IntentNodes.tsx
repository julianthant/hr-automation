import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Frame, Sparkles, StickyNote } from "lucide-react";
import type { CustomGraphNode, NoteGraphNode, GroupGraphNode } from "../graph-types.js";

const HANDLE_CLASS = "!h-2.5 !w-2.5 !rounded-full";

/** Design-intent element the runtime schema can't express yet (violet, dashed). */
function CustomNodeImpl({ data, selected }: NodeProps<CustomGraphNode>): JSX.Element {
  return (
    <div
      className={[
        "w-60 rounded-xl border border-dashed border-log-violet/50 bg-card/70 shadow-sm backdrop-blur-sm",
        selected ? "ring-2 ring-ring" : "",
      ].join(" ")}
    >
      <Handle type="target" position={Position.Left} id="in" className={HANDLE_CLASS} />
      <div className="flex items-center gap-1.5 border-b border-log-violet/20 px-2.5 py-1.5">
        <Sparkles aria-hidden className="h-3.5 w-3.5 shrink-0 text-log-violet" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-log-violet">
          Design intent
        </span>
      </div>
      <div className="space-y-1 px-2.5 py-2">
        <p className="truncate text-sm font-medium text-foreground">
          {data.label?.trim() || "Untitled element"}
        </p>
        {data.description?.trim() ? (
          <p className="line-clamp-3 text-[11px] leading-snug text-muted-foreground">{data.description}</p>
        ) : (
          <p className="text-[11px] italic text-muted-foreground">Describe it in the inspector →</p>
        )}
      </div>
      <Handle type="source" position={Position.Right} id="out" className={HANDLE_CLASS} />
    </div>
  );
}

/** A sticky annotation / design comment anchored on the canvas. */
function NoteNodeImpl({ data, selected }: NodeProps<NoteGraphNode>): JSX.Element {
  return (
    <div
      className={[
        "w-52 rounded-md border border-dashed border-muted-foreground/40 bg-muted/50 px-2.5 py-2 shadow-sm",
        selected ? "ring-2 ring-ring" : "",
      ].join(" ")}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <StickyNote aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Note</span>
      </div>
      <p className="whitespace-pre-wrap text-xs text-foreground">
        {data.text?.trim() || "Empty note"}
      </p>
    </div>
  );
}

/** A labeled frame grouping nodes into a "section / screen" intent. */
function GroupNodeImpl({ data, selected }: NodeProps<GroupGraphNode>): JSX.Element {
  return (
    <div
      className={[
        "h-44 w-72 rounded-xl border-2 border-dashed border-border bg-foreground/5",
        selected ? "ring-2 ring-ring" : "",
      ].join(" ")}
    >
      <div className="inline-flex items-center gap-1.5 rounded-br-lg rounded-tl-xl border-b border-r border-border bg-card/80 px-2 py-1">
        <Frame aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">{data.label?.trim() || "Section"}</span>
      </div>
    </div>
  );
}

export const CustomNode = memo(CustomNodeImpl);
export const NoteNode = memo(NoteNodeImpl);
export const GroupNode = memo(GroupNodeImpl);
