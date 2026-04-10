import { cn } from "@/lib/utils";
import type { RunInfo } from "./types";

interface RunSelectorProps {
  runs: RunInfo[];
  activeRunId: string | null;
  onSelect: (runId: string) => void;
}

export function RunSelector({ runs, activeRunId, onSelect }: RunSelectorProps) {
  if (runs.length <= 1) return null;

  return (
    <div className="flex gap-0.5 bg-secondary rounded-md p-0.5">
      {runs.map((run) => {
        const num = run.runId.split("#")[1] || "1";
        const isFailed = run.status === "failed";
        const isActive = run.runId === activeRunId;
        return (
          <button
            key={run.runId}
            onClick={() => onSelect(run.runId)}
            className={cn(
              "px-3.5 py-1 rounded text-xs font-mono font-medium transition-all cursor-pointer",
              "text-muted-foreground hover:text-foreground",
              isActive && "bg-accent text-foreground",
              isFailed && !isActive && "text-destructive",
            )}
          >
            Run #{num} {isFailed && "✗"}
          </button>
        );
      })}
    </div>
  );
}
