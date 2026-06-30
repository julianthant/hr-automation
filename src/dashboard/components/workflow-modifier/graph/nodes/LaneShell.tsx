import type { ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  ChevronDown,
  ChevronRight,
  CircleDot,
  CornerDownRight,
  EyeOff,
  Layers,
  Plus,
  Split,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { opKindVisual } from "../op-kind-visuals.js";
import type { ActionNodeData, AddedLaneOp } from "../graph-types.js";
import type { DryRunOpEffect, DryRunStepDiff, DryRunStepEffect } from "../../../../../domain/workflow-design/dry-run-diff.js";

const HANDLE_CLASS = "!h-2.5 !w-2.5 !rounded-full";

/** Token-only visual per dry-run effect — info for the gate (the branch point),
 *  warning for what a dry run skips. Reused by the lane header and op rows so the
 *  overlay reads identically wherever it appears. */
const DRY_RUN_STEP_VISUAL: Record<DryRunStepEffect, { label: string; tint: string }> = {
  gate: { label: "Dry-run gate", tint: "border-info/40 bg-info/12 text-info" },
  skip: { label: "Skipped in dry run", tint: "border-warning/40 bg-warning/12 text-warning" },
  partial: { label: "Partly skipped", tint: "border-warning/40 bg-warning/12 text-warning" },
};

/** Unique systems an op set touches, in first-seen order. */
function laneSystems(ops: ActionNodeData[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const op of ops) {
    if (!seen.has(op.system)) {
      seen.add(op.system);
      out.push(op.system);
    }
  }
  return out;
}

/** One mined op as a compact row: kind stripe + index + label + target + data flow.
 *  When the dry-run overlay is on, a `dryEffect` dims a skipped op (struck label +
 *  "skipped" tag) or marks the gate op (info tag) — purely presentational. */
function LaneOpRow({ op, index, dryEffect }: { op: ActionNodeData; index: number; dryEffect?: DryRunOpEffect }): JSX.Element {
  const v = opKindVisual(op.kind);
  const target = op.accessibleName
    ? `${op.role ?? "el"} · ${op.accessibleName}`
    : op.role ?? op.url ?? op.selectorFqn ?? "";
  const skipped = dryEffect === "skip";
  const gate = dryEffect === "gate";
  return (
    <div
      className={cn(
        "relative flex items-start gap-2 rounded-lg border border-border/70 bg-secondary/40 py-1.5 pl-3 pr-2",
        skipped && "opacity-60",
        gate && "border-info/40 bg-info/[0.06]",
      )}
    >
      <span aria-hidden className={cn("absolute inset-y-1.5 left-0 w-[3px] rounded-full", v.bgClass)} />
      <span className="mt-px w-4 shrink-0 text-right font-mono text-[10px] text-muted-foreground/70">
        {String(index).padStart(2, "0")}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn("truncate text-[12.5px] leading-tight text-foreground", skipped && "text-muted-foreground line-through")}
          title={op.label}
        >
          {op.label}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
          {skipped ? (
            <span className="inline-flex items-center gap-1 rounded-sm border border-warning/40 bg-warning/12 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-warning">
              <Ban aria-hidden className="h-2.5 w-2.5 shrink-0" />
              skipped
            </span>
          ) : null}
          {gate ? (
            <span className="inline-flex items-center gap-1 rounded-sm border border-info/40 bg-info/12 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-info">
              <Split aria-hidden className="h-2.5 w-2.5 shrink-0" />
              dry-run gate
            </span>
          ) : null}
          <span className={cn("inline-flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wide", v.accent)}>
            <v.icon aria-hidden className="h-3 w-3 shrink-0" />
            {v.verb}
          </span>
          <span className="rounded-sm border border-border bg-secondary/60 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
            {op.system}
          </span>
          {op.inputVar ? (
            <span
              className="inline-flex items-center gap-0.5 rounded-sm bg-log-teal/12 px-1 py-px font-mono text-[10px] text-log-teal"
              title={`fills from ${op.inputVar}`}
            >
              <ArrowDownToLine aria-hidden className="h-2.5 w-2.5 shrink-0" />
              <span className="max-w-[7rem] truncate">{op.inputVar}</span>
            </span>
          ) : null}
          {op.outputVar ? (
            <span
              className="inline-flex items-center gap-0.5 rounded-sm bg-log-cyan/12 px-1 py-px font-mono text-[10px] text-log-cyan"
              title={`scrapes into ${op.outputVar}`}
            >
              <ArrowUpFromLine aria-hidden className="h-2.5 w-2.5 shrink-0" />
              <span className="max-w-[7rem] truncate">{op.outputVar}</span>
            </span>
          ) : null}
          {target && !op.inputVar && !op.outputVar ? (
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground" title={op.selectorFqn ?? target}>
              {target}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** An op the operator DROPPED into this lane — a primary-tinted row with a remove
 *  control, set apart from the read-only mined ops above it. */
function AddedOpRow({ op, onRemove }: { op: AddedLaneOp; onRemove: () => void }): JSX.Element {
  const v = opKindVisual(op.kind);
  const target = op.accessibleName
    ? `${op.role ?? "el"} · ${op.accessibleName}`
    : op.role ?? op.url ?? op.selectorFqn ?? "";
  return (
    <div className="relative flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/[0.06] py-1.5 pl-3 pr-1.5">
      <span aria-hidden className={cn("absolute inset-y-1.5 left-0 w-[3px] rounded-full", v.bgClass)} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] leading-tight text-foreground" title={op.label}>
          {op.label}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="inline-flex items-center gap-1 rounded-sm border border-primary/40 bg-primary/12 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-primary">
            <Plus aria-hidden className="h-2.5 w-2.5 shrink-0" />
            added
          </span>
          <span className={cn("inline-flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wide", v.accent)}>
            <v.icon aria-hidden className="h-3 w-3 shrink-0" />
            {v.verb}
          </span>
          <span className="rounded-sm border border-border bg-secondary/60 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
            {op.system}
          </span>
          {op.inputVar ? (
            <span
              className="inline-flex items-center gap-0.5 rounded-sm bg-log-teal/12 px-1 py-px font-mono text-[10px] text-log-teal"
              title={`fills from ${op.inputVar}`}
            >
              <ArrowDownToLine aria-hidden className="h-2.5 w-2.5 shrink-0" />
              <span className="max-w-[7rem] truncate">{op.inputVar}</span>
            </span>
          ) : null}
          {op.outputVar ? (
            <span
              className="inline-flex items-center gap-0.5 rounded-sm bg-log-cyan/12 px-1 py-px font-mono text-[10px] text-log-cyan"
              title={`scrapes into ${op.outputVar}`}
            >
              <ArrowUpFromLine aria-hidden className="h-2.5 w-2.5 shrink-0" />
              <span className="max-w-[7rem] truncate">{op.outputVar}</span>
            </span>
          ) : null}
          {target && !op.inputVar && !op.outputVar ? (
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground" title={op.selectorFqn ?? target}>
              {target}
            </span>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        aria-label={`Remove ${op.label}`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="nodrag mt-px shrink-0 rounded p-0.5 text-muted-foreground outline-none transition-colors hover:bg-destructive/15 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X aria-hidden className="h-3.5 w-3.5 shrink-0" />
      </button>
    </div>
  );
}

interface LaneShellProps {
  /** Header glyph. */
  icon: LucideIcon;
  /** Header eyebrow, e.g. "STEP 2" or "OPS". */
  eyebrow: string;
  /** Lane title (step label). */
  title: string;
  /** The lane's mined ops (nested rows). */
  ops: ActionNodeData[];
  /** Ops the operator dropped into this lane (rendered beneath the mined ops). */
  addedOps?: AddedLaneOp[];
  /** Remove a dropped op by its id. */
  onRemoveAddedOp?: (addedId: string) => void;
  /** Highlight the lane as the active Data Bank drop target. */
  isDropTarget?: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  selected?: boolean;
  /** A configured (vs default) lane draws the primary rail + dot. */
  modified?: boolean;
  hidden?: boolean;
  foldInto?: string;
  foldedCount?: number;
  /** Header icon tone (token text class). */
  accentClass?: string;
  hasTarget?: boolean;
  hasSource?: boolean;
  /** Right-aligned header note, e.g. "read-only". */
  badge?: ReactNode;
  /** Dry-run overlay is on (drives the per-op + lane annotation). */
  dryRunOn?: boolean;
  /** This step's dry-run diff (undefined → runs identically in both modes). */
  dryRun?: DryRunStepDiff | null;
}

/**
 * The step "lane": a container node that owns its ops as nested rows. Collapsed →
 * header only (count / systems / reads-writes summary); expanded → the ordered op
 * rows in an internal-scroll body capped so a 21-op lane stays the same height as
 * a 5-op one. The whole card is the React Flow node body (selection opens the
 * inspector); the chevron is the only nested control (collapse). Token-only color,
 * `nodrag`/`nowheel` so internal scroll never pans the canvas.
 */
export function LaneShell({
  icon: Icon,
  eyebrow,
  title,
  ops,
  addedOps = [],
  onRemoveAddedOp,
  isDropTarget = false,
  collapsed,
  onToggleCollapse,
  selected = false,
  modified = false,
  hidden = false,
  foldInto,
  foldedCount = 0,
  accentClass = "text-muted-foreground",
  hasTarget = false,
  hasSource = false,
  badge,
  dryRunOn = false,
  dryRun = null,
}: LaneShellProps): JSX.Element {
  const systems = laneSystems(ops);
  const reads = ops.filter((o) => o.inputVar).length;
  const writes = ops.filter((o) => o.outputVar).length;
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  // Dry-run overlay: a divergent lane gets a colored rail (info gate / warning
  // skip), a header pill, and — for a fully-skipped step — a dim. The rail wins
  // over the "modified" primary rail while the overlay is on (it's a transient view).
  const dryActive = dryRunOn && !!dryRun;
  const dryVisual = dryActive ? DRY_RUN_STEP_VISUAL[dryRun.effect] : null;

  return (
    <div
      className={cn(
        "w-[20rem] rounded-2xl border border-border bg-card/90 shadow-md backdrop-blur-sm transition-colors",
        modified && "border-l-2 border-l-primary",
        dryActive && dryRun.effect === "gate" && "border-l-2 border-l-info",
        dryActive && dryRun.effect !== "gate" && "border-l-2 border-l-warning",
        dryActive && dryRun.effect === "skip" && "opacity-70",
        selected && "ring-2 ring-ring",
        isDropTarget && "ring-2 ring-primary",
        hidden && "opacity-70",
      )}
    >
      {hasTarget ? (
        <Handle type="target" position={Position.Left} id="in" className={HANDLE_CLASS} />
      ) : null}

      {/* Header */}
      <div className="px-3 pb-2.5 pt-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse();
            }}
            className="nodrag rounded p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Chevron aria-hidden className="h-4 w-4 shrink-0" />
          </button>
          <Icon aria-hidden className={cn("h-3.5 w-3.5 shrink-0", accentClass)} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {eyebrow}
          </span>
          {modified ? <CircleDot aria-hidden className="h-3 w-3 shrink-0 text-primary" /> : null}
          {badge ? <span className="ml-auto">{badge}</span> : null}
        </div>

        <div className={cn("mt-1.5 flex items-center gap-1.5", hidden && "line-through")}>
          {hidden ? <EyeOff aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
          <p
            className={cn("min-w-0 truncate text-[15px] font-semibold", hidden ? "text-muted-foreground" : "text-foreground")}
            title={title}
          >
            {title}
          </p>
        </div>

        {/* Summary chips */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {dryVisual ? (
            <span
              className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", dryVisual.tint)}
              title={dryRun?.reason}
            >
              {dryRun?.effect === "gate" ? (
                <Split aria-hidden className="h-3 w-3 shrink-0" />
              ) : (
                <Ban aria-hidden className="h-3 w-3 shrink-0" />
              )}
              {dryVisual.label}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <Layers aria-hidden className="h-3 w-3 shrink-0" />
            {ops.length} {ops.length === 1 ? "op" : "ops"}
          </span>
          {addedOps.length ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/12 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              <Plus aria-hidden className="h-3 w-3 shrink-0" />
              {addedOps.length} added
            </span>
          ) : null}
          {systems.map((s) => (
            <span
              key={s}
              className="rounded-md border border-border bg-secondary px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {s}
            </span>
          ))}
          {reads > 0 ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-log-teal" title={`${reads} input(s)`}>
              <ArrowDownToLine aria-hidden className="h-3 w-3 shrink-0" />
              {reads}
            </span>
          ) : null}
          {writes > 0 ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-log-cyan" title={`${writes} output(s)`}>
              <ArrowUpFromLine aria-hidden className="h-3 w-3 shrink-0" />
              {writes}
            </span>
          ) : null}
          {foldInto ? (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
              <CornerDownRight aria-hidden className="h-3 w-3 shrink-0" />
              folds into {foldInto}
            </span>
          ) : null}
          {foldedCount > 0 ? (
            <span className="inline-flex items-center rounded-full border border-warning/40 bg-warning/12 px-1.5 py-0.5 text-[10px] font-medium text-warning">
              +{foldedCount} folded
            </span>
          ) : null}
        </div>
      </div>

      {/* Body — mined op rows + dropped "added" rows (internal scroll, capped) */}
      {!collapsed ? (
        ops.length || addedOps.length ? (
          <div className="nodrag nowheel max-h-[22rem] space-y-1 overflow-y-auto border-t border-border/70 px-2 py-2">
            {ops.map((op, i) => (
              <LaneOpRow
                key={`${op.opId}:${i}`}
                op={op}
                index={i}
                dryEffect={
                  dryActive ? (dryRun.effect === "skip" ? "skip" : dryRun.opEffects[op.opId]) : undefined
                }
              />
            ))}
            {addedOps.length ? (
              <>
                <div className="flex items-center gap-1.5 px-1 pb-0.5 pt-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-primary">
                  <Plus aria-hidden className="h-3 w-3 shrink-0" />
                  Added from Data Bank
                </div>
                {addedOps.map((op) => (
                  <AddedOpRow key={op.addedId} op={op} onRemove={() => onRemoveAddedOp?.(op.addedId)} />
                ))}
              </>
            ) : null}
          </div>
        ) : (
          <div className="border-t border-border/70 px-3 py-3 text-[11px] italic text-muted-foreground">
            No operations yet — drag one in from the Data Bank.
          </div>
        )
      ) : null}

      {hasSource ? (
        <Handle type="source" position={Position.Right} id="out" className={HANDLE_CLASS} />
      ) : null}
    </div>
  );
}
