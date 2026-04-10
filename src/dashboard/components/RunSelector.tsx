import { cn } from "@/lib/utils";
import type { RunInfo } from "./types";

interface RunSelectorProps {
  runs: RunInfo[];
  activeRunId: string | null;
  onSelect: (runId: string) => void;
}

export function RunSelector({ runs, activeRunId, onSelect }: RunSelectorProps) {
  if (runs.length === 0) return null;

  return (
    <div className="flex gap-2">
      {runs.map((run) => {
        const num = run.runId.split("#")[1] || "1";
        const isFailed = run.status === "failed";
        const isDone = run.status === "done";
        const isRunning = run.status === "running";
        const isActive = run.runId === activeRunId;
        return (
          <button
            key={run.runId}
            onClick={() => onSelect(run.runId)}
            className={cn(
              "px-3 py-0.5 rounded-full text-xs font-mono font-medium transition-all cursor-pointer border",
              "text-muted-foreground hover:text-foreground",
              !isActive && "border-border bg-transparent",
              isActive && !isFailed && !isDone && "border-primary/40 bg-primary/10 text-primary",
              isActive && isDone && "border-[#4ade80]/40 bg-[#4ade80]/10 text-[#4ade80]",
              isActive && isFailed && "border-destructive/40 bg-destructive/10 text-destructive",
              !isActive && isFailed && "text-destructive/70",
              isRunning && isActive && "animate-pulse",
            )}
          >
            #{num} {isFailed ? "✗" : isDone ? "✓" : isRunning ? "●" : ""}
          </button>
        );
      })}
    </div>
  );
}
