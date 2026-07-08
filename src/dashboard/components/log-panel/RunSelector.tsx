import { useMemo } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Check, X, Play, SearchX, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { DeleteButton } from "@/components/shared/DeleteButton";
import { RetryButton } from "@/components/shared/RetryButton";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import type { RunInfo } from "@/components/shared/types";
import { queueStatusDisplayLabel } from "../../../domain/tracker-terminal-display.js";

interface RunSelectorProps {
  runs: RunInfo[];
  activeRunId: string | null;
  onSelect: (runId: string) => void;
  /** Workflow id for per-run outcome labels (e.g. "Not found" for eid-lookup). */
  workflow: string;
  retryTarget?: {
    workflow: string;
    id: string;
    runId?: string;
    date?: string;
  };
  deleteTarget?: {
    workflow: string;
    id: string;
    date: string;
    runId?: string | null;
    onDeleted: (id: string) => void;
  };
  /**
   * True when the most recent `/api/runs` refetch failed for at least one
   * merged member — `runs` keeps its last-known-good list rather than being
   * silently truncated, but this run history may be stale. Shows a
   * distinguishable warning glyph instead of reading identically to "this
   * confirmed run list has no other attempts."
   */
  stale?: boolean;
}

/**
 * Display ordinal for a run. Prefers the backend-assigned `runOrdinal`
 * (chronological, 1-indexed, works for both `{id}#N` and UUID runIds).
 * Falls back to parsing `{id}#N` for legacy payloads that predate the
 * `runOrdinal` enrichment — and finally to 0 if neither is available.
 */
function runNumber(run: RunInfo): number {
  if (typeof run.runOrdinal === "number" && run.runOrdinal > 0) return run.runOrdinal;
  const n = Number.parseInt(run.runId.split("#")[1] ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

function runDisplayStatus(workflow: string, run: RunInfo): string {
  return queueStatusDisplayLabel({
    workflow,
    status: run.status,
    data: run.data,
  });
}

function statusGlyph(run: RunInfo, workflow: string) {
  const display = runDisplayStatus(workflow, run);
  if (run.status === "failed") return <X className="w-3 h-3" aria-hidden />;
  if (display === "Not found") return <SearchX className="w-3 h-3" aria-hidden />;
  if (run.status === "done") return <Check className="w-3 h-3" aria-hidden />;
  if (run.status === "running") return <Play className="w-3 h-3" aria-hidden />;
  return null;
}

function statusColor(run: RunInfo, workflow: string): string {
  const display = runDisplayStatus(workflow, run);
  if (run.status === "failed") return "text-destructive";
  if (display === "Not found") return "text-muted-foreground";
  if (run.status === "done") return "text-[#4ade80]";
  if (run.status === "running") return "text-primary";
  return "text-muted-foreground";
}

/**
 * Dropdown of past + current runs for an entry. Sorted **numerically descending**
 * (most recent first, so #25 lists above #2 instead of "#1, #10, #11, …, #2"
 * which alphabetic sort would produce). Opens an ordered list of every run
 * with its status glyph; the trigger always shows the active run + a chevron.
 */
export function RunSelector({ runs, activeRunId, onSelect, retryTarget, deleteTarget, workflow, stale }: RunSelectorProps) {
  // Numeric desc — newest run on top regardless of how it was inserted upstream.
  const sortedRuns = useMemo(
    () => [...runs].sort((a, b) => runNumber(b) - runNumber(a)),
    [runs],
  );

  if (sortedRuns.length === 0) return null;

  const active = sortedRuns.find((r) => r.runId === activeRunId) ?? sortedRuns[0];
  const activeNum = runNumber(active);
  const activeDisplay = runDisplayStatus(workflow, active);
  const totalRuns = sortedRuns.length;
  // sortedRuns is desc (newest first), so index 0 = newest, last index = oldest
  const activeIndex = sortedRuns.findIndex((r) => r.runId === active.runId);
  const canGoNewer = activeIndex > 0;
  const canGoOlder = activeIndex < sortedRuns.length - 1;

  const navBtnClass = cn(
    "h-8 w-8 inline-flex items-center justify-center rounded-md border border-border bg-secondary cursor-pointer transition-colors",
    "text-muted-foreground hover:text-foreground hover:border-primary",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
    "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:text-muted-foreground",
  );

  return (
    <div className="flex items-center gap-1">
      {retryTarget && (
        <RetryButton
          workflow={retryTarget.workflow}
          id={retryTarget.id}
          runId={retryTarget.runId}
          date={retryTarget.date}
          size="md"
          className="rounded-md"
        />
      )}
      {deleteTarget && (
        <DeleteButton
          workflow={deleteTarget.workflow}
          id={deleteTarget.id}
          date={deleteTarget.date}
          runId={deleteTarget.runId ?? undefined}
          onDeleted={deleteTarget.onDeleted}
          size="md"
          className="rounded-md"
        />
      )}
      <button
        type="button"
        aria-label="Older run"
        disabled={!canGoOlder}
        onClick={() => canGoOlder && onSelect(sortedRuns[activeIndex + 1].runId)}
        className={navBtnClass}
      >
        <ChevronLeft className="w-3.5 h-3.5" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={
              stale
                ? `Run #${activeNum} of ${totalRuns} — ${activeDisplay} — run history may be stale, refresh failed`
                : `Run #${activeNum} of ${totalRuns} — ${activeDisplay}`
            }
            title={stale ? "Couldn't refresh run history — showing the last-known list" : undefined}
            className={cn(
              "h-8 min-w-[126px] px-3 rounded-md border border-border bg-secondary cursor-pointer",
              "inline-flex items-center justify-center gap-2 transition-colors",
              "hover:bg-accent data-[state=open]:border-primary outline-none focus-visible:ring-2 focus-visible:ring-primary",
            )}
          >
            <span className={cn("flex items-center gap-1 font-mono text-xs font-medium tabular-nums", statusColor(active, workflow))}>
              {statusGlyph(active, workflow)}
              #{activeNum}
            </span>
            <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
              of {totalRuns}
            </span>
            {stale && (
              <AlertTriangle
                aria-hidden
                className="w-3 h-3 shrink-0 text-warning"
              />
            )}
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground transition-transform data-[state=open]:rotate-180" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[200px] max-h-[320px] overflow-y-auto">
          {sortedRuns.map((run) => {
            const num = runNumber(run);
            const isActive = run.runId === active.runId;
            return (
              <DropdownMenuItem
                key={run.runId}
                onClick={() => onSelect(run.runId)}
                className={cn(isActive && "bg-accent")}
              >
                <span className="flex items-center justify-between w-full">
                  <span className={cn("flex items-center gap-1.5 font-mono font-medium tabular-nums", statusColor(run, workflow))}>
                    {statusGlyph(run, workflow)}
                    Run #{num}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {runDisplayStatus(workflow, run)}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        aria-label="Newer run"
        disabled={!canGoNewer}
        onClick={() => canGoNewer && onSelect(sortedRuns[activeIndex - 1].runId)}
        className={navBtnClass}
      >
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
