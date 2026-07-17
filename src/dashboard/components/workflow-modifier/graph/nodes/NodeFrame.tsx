import type { JSX } from "react";
import type { ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import type { LucideIcon } from "lucide-react";
import { CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";

interface NodeFrameProps {
  /** Lucide glyph for the typed header strip. */
  icon: LucideIcon;
  /** Node-kind label (the header eyebrow), e.g. "Queue row". */
  kind: string;
  /** Token text class for the header icon (defaults to muted). */
  accentClass?: string;
  /** React Flow selection — draws the focus ring. */
  selected?: boolean;
  /** Differs from the workflow default — draws the primary left rail + dot. */
  modified?: boolean;
  /** Width utility so node positions line up with the projection's layout grid. */
  widthClass?: string;
  /** Render the left (target) port. */
  hasTarget?: boolean;
  /** Render the right (source) port. */
  hasSource?: boolean;
  children: ReactNode;
}

const HANDLE_CLASS = "!h-2.5 !w-2.5 !rounded-full";

/**
 * Shared chrome for every config-backed graph node: a rounded card with a typed
 * header strip and token-styled left/right ports. Selection draws a focus ring;
 * the "modified vs default" state reuses the blueprint's language — a 2px
 * primary left rail + a CircleDot — so a configured node reads at a glance.
 */
export function NodeFrame({
  icon: Icon,
  kind,
  accentClass = "text-muted-foreground",
  selected = false,
  modified = false,
  widthClass = "w-60",
  hasTarget = false,
  hasSource = false,
  children,
}: NodeFrameProps): JSX.Element {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card/80 shadow-sm backdrop-blur-sm transition-colors",
        "text-foreground",
        widthClass,
        modified && "border-l-2 border-l-primary",
        selected && "ring-2 ring-ring",
      )}
    >
      {hasTarget ? (
        <Handle type="target" position={Position.Left} id="in" className={HANDLE_CLASS} />
      ) : null}

      <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
        <Icon aria-hidden className={cn("h-3.5 w-3.5 shrink-0", accentClass)} />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {kind}
        </span>
        {modified ? (
          <CircleDot aria-hidden className="ml-auto h-3 w-3 shrink-0 text-primary" />
        ) : null}
      </div>

      <div className="px-2.5 py-2">{children}</div>

      {hasSource ? (
        <Handle type="source" position={Position.Right} id="out" className={HANDLE_CLASS} />
      ) : null}
    </div>
  );
}
