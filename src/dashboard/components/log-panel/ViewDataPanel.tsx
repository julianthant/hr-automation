import { useMemo } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Database } from "lucide-react";
import type { CollapsedLogEntry } from "@/components/hooks/useLogs";
import { formatStepName } from "@/components/shared/types";
import { cn } from "@/lib/utils";
import {
  groupDataPointsByStep,
  type DataPointView,
  type DataStepGroup,
} from "../../../domain/data-point.js";

interface ViewDataPanelProps {
  /** The run's full (collapsed) log stream — the same source the Logs tab uses.
   *  Data points are filtered + grouped out of it by `groupDataPointsByStep`. */
  logs: CollapsedLogEntry[];
  loading?: boolean;
}

/**
 * "View Data" log-panel surface — a step-by-step ledger of the data a run
 * EXTRACTED (read) and INPUTTED (write), recorded via `ctx.recordData`. Each
 * workflow step is a station on a timeline spine; within a station, reads and
 * writes split into two lanes encoded by BOTH icon and accent token (never
 * color alone) — `log-cyan`/down-arrow for extracted, `log-teal`/up-arrow for
 * inputted, the same accents the Logs category legend uses for Extract/Fill.
 *
 * The tab is gated upstream (only shown when the run recorded ≥1 point), so the
 * empty state is a safety net rather than the common path.
 */
export function ViewDataPanel({ logs, loading }: ViewDataPanelProps) {
  const groups = useMemo(() => groupDataPointsByStep(logs), [logs]);

  const totals = useMemo(() => {
    let reads = 0;
    let writes = 0;
    for (const g of groups) {
      reads += g.reads.length;
      writes += g.writes.length;
    }
    return { reads, writes };
  }, [groups]);

  if (loading && groups.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="space-y-3 px-5 py-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="h-3 w-32 rounded bg-muted motion-safe:animate-pulse" />
              <div className="h-12 rounded-md bg-muted motion-safe:animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <Database aria-hidden className="h-7 w-7 text-muted-foreground/60" />
        <p className="text-sm font-medium text-foreground">No data recorded for this run</p>
        <p className="max-w-xs text-[12px] leading-relaxed text-muted-foreground">
          Steps that extract or input values surface them here. This run didn’t
          record any data points.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Summary strip — totals across the whole run. */}
      <div className="flex shrink-0 items-center gap-4 border-b border-border px-5 py-2.5 text-[12px]">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <ArrowDownToLine aria-hidden className="h-3.5 w-3.5 text-log-cyan" />
          <span className="font-medium text-foreground tabular-nums">{totals.reads}</span>
          extracted
        </span>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <ArrowUpFromLine aria-hidden className="h-3.5 w-3.5 text-log-teal" />
          <span className="font-medium text-foreground tabular-nums">{totals.writes}</span>
          inputted
        </span>
        <span className="ml-auto text-muted-foreground tabular-nums">
          {groups.length} {groups.length === 1 ? "step" : "steps"}
        </span>
      </div>

      {/* Timeline of step stations. */}
      <ol className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {groups.map((group, idx) => (
          <StepStation key={group.step} group={group} isLast={idx === groups.length - 1} />
        ))}
      </ol>
    </div>
  );
}

function StepStation({ group, isLast }: { group: DataStepGroup; isLast: boolean }) {
  return (
    <li className={cn("relative border-l border-border pl-5", isLast ? "pb-0" : "pb-5")}>
      {/* Spine node — punches through the connecting rule via a card-colored ring. */}
      <span
        aria-hidden
        className="absolute -left-[5px] top-1 h-2.5 w-2.5 rounded-full bg-primary ring-4 ring-card"
      />
      <h3 className="mb-2 flex items-baseline gap-2 leading-none">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-foreground">
          {formatStepName(group.step)}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {group.reads.length > 0 && `${group.reads.length} read`}
          {group.reads.length > 0 && group.writes.length > 0 && " · "}
          {group.writes.length > 0 && `${group.writes.length} written`}
        </span>
      </h3>

      <div className="space-y-2">
        {group.reads.length > 0 && (
          <DataLane direction="read" points={group.reads} />
        )}
        {group.writes.length > 0 && (
          <DataLane direction="write" points={group.writes} />
        )}
      </div>
    </li>
  );
}

const LANE_META = {
  read: {
    label: "Extracted",
    Icon: ArrowDownToLine,
    border: "border-log-cyan/30",
    bg: "bg-log-cyan/10",
    accent: "text-log-cyan",
  },
  write: {
    label: "Inputted",
    Icon: ArrowUpFromLine,
    border: "border-log-teal/30",
    bg: "bg-log-teal/10",
    accent: "text-log-teal",
  },
} as const;

function DataLane({
  direction,
  points,
}: {
  direction: "read" | "write";
  points: DataPointView[];
}) {
  const meta = LANE_META[direction];
  const Icon = meta.Icon;
  return (
    <div className={cn("rounded-md border", meta.border, meta.bg)}>
      <div className={cn("flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide", meta.accent)}>
        <Icon aria-hidden className="h-3.5 w-3.5" />
        {meta.label}
      </div>
      <ul className="divide-y divide-border/40">
        {points.map((point, i) => (
          <DataRow key={`${point.field}-${i}`} point={point} />
        ))}
      </ul>
    </div>
  );
}

function DataRow({ point }: { point: DataPointView }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
      {point.system && (
        <span className="shrink-0 rounded border border-border/60 bg-secondary/90 px-1.5 py-px font-mono text-[10px] text-muted-foreground">
          {point.system}
        </span>
      )}
      <span className="text-[12px] text-muted-foreground">{point.label}</span>
      <span className="font-mono text-[13px] tabular-nums text-foreground break-all">
        {point.value}
      </span>
      {point.note && (
        <span className="basis-full text-[11px] italic leading-snug text-muted-foreground/80">
          {point.note}
        </span>
      )}
    </li>
  );
}
