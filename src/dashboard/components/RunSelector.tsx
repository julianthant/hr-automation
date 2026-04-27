import { useMemo } from "react";
import { ChevronDown, Check, X, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import type { RunInfo } from "./types";

interface RunSelectorProps {
  runs: RunInfo[];
  activeRunId: string | null;
  onSelect: (runId: string) => void;
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

function statusGlyph(status: string) {
  if (status === "failed") return <X className="w-3 h-3" aria-hidden />;
  if (status === "done") return <Check className="w-3 h-3" aria-hidden />;
  if (status === "running") return <Play className="w-3 h-3" aria-hidden />;
  return null;
}

function statusColor(status: string): string {
  if (status === "failed") return "text-destructive";
  if (status === "done") return "text-[#4ade80]";
  if (status === "running") return "text-primary";
  return "text-muted-foreground";
}

/**
 * Dropdown of past + current runs for an entry. Sorted **numerically descending**
 * (most recent first, so #25 lists above #2 instead of "#1, #10, #11, …, #2"
 * which alphabetic sort would produce). Opens an ordered list of every run
 * with its status glyph; the trigger always shows the active run + a chevron.
 */
export function RunSelector({ runs, activeRunId, onSelect }: RunSelectorProps) {
  // Numeric desc — newest run on top regardless of how it was inserted upstream.
  const sortedRuns = useMemo(
    () => [...runs].sort((a, b) => runNumber(b) - runNumber(a)),
    [runs],
  );

  if (sortedRuns.length === 0) return null;

  const active = sortedRuns.find((r) => r.runId === activeRunId) ?? sortedRuns[0];
  const activeNum = runNumber(active);
  const totalRuns = sortedRuns.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Run #${activeNum} of ${totalRuns} — ${active.status}`}
          className={cn(
            "flex items-center gap-2 h-8 px-3 rounded-lg border border-border bg-secondary cursor-pointer transition-colors hover:border-primary data-[state=open]:border-primary outline-none focus-visible:ring-2 focus-visible:ring-primary",
          )}
        >
          <span className={cn("flex items-center gap-1 font-mono text-xs font-medium tabular-nums", statusColor(active.status))}>
            {statusGlyph(active.status)}
            #{activeNum}
          </span>
          <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
            of {totalRuns}
          </span>
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
                <span className={cn("flex items-center gap-1.5 font-mono font-medium tabular-nums", statusColor(run.status))}>
                  {statusGlyph(run.status)}
                  Run #{num}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {run.status}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
