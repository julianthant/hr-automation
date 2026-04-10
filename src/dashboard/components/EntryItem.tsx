import { cn } from "@/lib/utils";
import type { TrackerEntry } from "./types";
import { getConfig } from "./types";
import { useElapsed } from "./hooks/useElapsed";

interface EntryItemProps {
  entry: TrackerEntry;
  workflow: string;
  selected: boolean;
  onClick: () => void;
}

const badgeStyles: Record<string, string> = {
  running: "bg-primary/15 text-primary",
  done: "bg-[#4ade80]/12 text-[#4ade80]",
  failed: "bg-destructive/12 text-destructive",
  pending: "bg-[#fbbf24]/12 text-[#fbbf24]",
  skipped: "bg-secondary text-muted-foreground",
};

export function EntryItem({ entry, workflow, selected, onClick }: EntryItemProps) {
  const cfg = getConfig(workflow);
  const name = cfg.getName(entry);
  const isRunning = entry.status === "running";
  const isFailed = entry.status === "failed";
  const isDone = entry.status === "done";
  const elapsed = useElapsed(isRunning ? entry.timestamp : null);

  const runNumber = entry.runId?.split("#")[1];
  const showRun = runNumber && parseInt(runNumber) > 1;

  const time = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "";

  return (
    <div
      onClick={onClick}
      className={cn(
        "px-5 py-3.5 border-b border-border cursor-pointer transition-colors",
        "hover:bg-secondary",
        selected && "bg-accent border-l-[3px] border-l-primary pl-[17px]",
      )}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="font-semibold text-[15px]">{name || entry.id}</span>
        <span className={cn("text-[11px] font-semibold px-2.5 py-0.5 rounded-xl uppercase tracking-wide font-mono", badgeStyles[entry.status])}>
          {entry.status}
        </span>
      </div>

      {name && (
        <div className="font-mono text-[13px] text-muted-foreground mt-0.5">{entry.id}</div>
      )}

      {isFailed && entry.error && (
        <div className="font-mono text-xs text-destructive mt-1.5 truncate">
          ✗ {entry.error}
        </div>
      )}

      <div className="flex items-center gap-2.5 mt-2">
        {isRunning && entry.step && (
          <span className="font-mono text-xs text-accent-foreground">
            ▶ {entry.step.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}
          </span>
        )}
        {!isRunning && !isFailed && (
          <span className="font-mono text-xs text-muted-foreground">{time}</span>
        )}
        {showRun && (
          <span className="font-mono text-[11px] text-muted-foreground bg-secondary px-2 py-0.5 rounded font-medium">
            Run #{runNumber}
          </span>
        )}
        <span className="flex-1" />
        {isRunning && elapsed && (
          <span className="font-mono text-xs text-primary">{elapsed}</span>
        )}
        {isDone && (
          <span className="font-mono text-xs text-muted-foreground">{time}</span>
        )}
        {isFailed && (
          <span className="font-mono text-xs text-muted-foreground">{time}</span>
        )}
      </div>
    </div>
  );
}
