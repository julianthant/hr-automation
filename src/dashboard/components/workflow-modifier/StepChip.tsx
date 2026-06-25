import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CornerDownRight,
  Eye,
  EyeOff,
  GripVertical,
  Plus,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { formatStepName } from "../shared/types.js";

export interface StepChipModel {
  step: string;
  label: string;
  hidden: boolean;
  foldInto?: string;
  /** How many other steps fold INTO this one (drives the +N pill). */
  foldCount: number;
  modified: boolean;
}

interface StepChipProps {
  model: StepChipModel;
  index: number;
  total: number;
  /** Other steps available as fold targets: {id, label}. */
  foldTargets: { id: string; label: string }[];
  /** Resolved label of this chip's fold host, when folded. */
  hostLabel?: string;
  isDragging: boolean;
  isDragOver: boolean;
  onRename: (label: string | undefined) => void;
  onFold: (target: string | undefined) => void;
  onToggleHidden: (hidden: boolean) => void;
  onMove: (dir: "up" | "down") => void;
  onReset: () => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

export function StepChip({
  model,
  index,
  total,
  foldTargets,
  hostLabel,
  isDragging,
  isDragOver,
  onRename,
  onFold,
  onToggleHidden,
  onMove,
  onReset,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
}: StepChipProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const { step, label, hidden, foldInto, foldCount, modified } = model;
  const renameId = `step-rename-${step}`;
  const foldId = `step-fold-${step}`;

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={onDragEnter}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      className={cn(
        "flex items-center gap-1 rounded-md border bg-secondary/40 pl-1 pr-1 py-1 transition-colors duration-200",
        modified ? "border-l-2 border-primary" : "border-border",
        hidden && "border-dashed opacity-60",
        isDragOver && "ring-1 ring-primary/60",
        isDragging && "opacity-50 ring-2 ring-ring",
      )}
    >
      {/* Drag handle (pointer-only; the chevrons are the keyboard path) */}
      <span
        aria-hidden
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className="shrink-0 cursor-grab text-muted-foreground/50 transition-colors hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </span>

      {/* Label → opens the edit popover */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Edit step ${formatStepName(step)}`}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1 text-xs",
              "cursor-pointer outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            {modified ? (
              <CircleDot aria-hidden className="h-3 w-3 shrink-0 text-primary" />
            ) : null}
            {hidden ? (
              <EyeOff aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : null}
            <span className={cn("font-medium", hidden ? "text-muted-foreground line-through" : "text-foreground")}>
              {label}
            </span>
            {foldCount > 0 ? (
              <span
                className="inline-flex items-center gap-0.5 rounded bg-primary/15 px-1 text-[10px] font-semibold leading-none text-primary"
                aria-label={`${foldCount} folded step${foldCount !== 1 ? "s" : ""}`}
              >
                <Plus aria-hidden className="h-2.5 w-2.5" />
                {foldCount}
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-3">
          <div className="mb-2 flex items-center gap-1.5">
            <p className="font-mono text-[11px] text-muted-foreground">{step}</p>
            {modified ? (
              <>
                <CircleDot aria-hidden className="ml-auto h-3 w-3 shrink-0 text-primary" />
                <button
                  type="button"
                  aria-label={`Reset step ${formatStepName(step)} to default`}
                  onClick={() => {
                    onReset();
                    setOpen(false);
                  }}
                  className="rounded p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <RotateCcw aria-hidden className="h-3.5 w-3.5 shrink-0" />
                </button>
              </>
            ) : null}
          </div>

          <label htmlFor={renameId} className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
            Label
          </label>
          <input
            id={renameId}
            type="text"
            value={model.label === formatStepName(step) ? "" : model.label}
            placeholder={formatStepName(step)}
            onChange={(e) => onRename(e.target.value || undefined)}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
          />

          <label htmlFor={foldId} className="mb-1 mt-3 block text-[11px] uppercase tracking-wide text-muted-foreground">
            Fold into
          </label>
          <select
            id={foldId}
            value={foldInto ?? ""}
            onChange={(e) => onFold(e.target.value || undefined)}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">— Keep separate —</option>
            {foldTargets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </PopoverContent>
      </Popover>

      {foldInto ? (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground" aria-hidden>
          <CornerDownRight className="h-3 w-3" />
          {hostLabel}
        </span>
      ) : null}

      <div className="ml-0.5 flex shrink-0 items-center">
        <button
          type="button"
          aria-label={hidden ? `Show step ${formatStepName(step)}` : `Hide step ${formatStepName(step)}`}
          aria-pressed={hidden}
          onClick={() => onToggleHidden(!hidden)}
          className="rounded p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {hidden ? <EyeOff aria-hidden className="h-3.5 w-3.5" /> : <Eye aria-hidden className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          aria-label={`Move ${formatStepName(step)} earlier`}
          disabled={index === 0}
          onClick={() => onMove("up")}
          className="rounded p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={`Move ${formatStepName(step)} later`}
          disabled={index === total - 1}
          onClick={() => onMove("down")}
          className="rounded p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
