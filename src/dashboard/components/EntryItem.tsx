import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import type { TrackerEntry } from "./types";
import { getConfig } from "./types";
import { useElapsed, formatDuration } from "./hooks/useElapsed";

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
  const isPending = entry.status === "pending";
  const firstTs = entry.firstLogTs || entry.startTimestamp || entry.timestamp;
  const lastTs = entry.lastLogTs || entry.timestamp;
  const elapsed = useElapsed(isRunning ? firstTs : null);
  const duration = (isDone || isFailed) && firstTs !== lastTs
    ? formatDuration(firstTs, lastTs)
    : null;

  const runNumber = entry.runId?.split("#")[1] || "1";
  const time = entry.firstLogTs || entry.timestamp
    ? new Date(entry.firstLogTs || entry.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "";

  return (
    <div
      onClick={onClick}
      className={cn(
        "px-5 py-3 border-b border-border cursor-pointer transition-colors",
        "hover:bg-secondary",
        selected && "bg-accent border-l-[3px] border-l-primary pl-[17px]",
      )}
    >
      {/* Row 1: Name + status badge */}
      <div className="flex items-center justify-between">
        <span className="font-semibold text-[15px] truncate">{name || entry.id}</span>
        <span className={cn("text-[10px] font-semibold px-2.5 py-0.5 rounded-xl uppercase tracking-wide font-mono flex-shrink-0 ml-2", badgeStyles[entry.status])}>
          {entry.status}
        </span>
      </div>

      {/* Row 2: Doc ID + workflow instance tag */}
      {name && (
        <div className="flex items-center justify-between mt-0.5">
          <span className="font-mono text-[13px] text-muted-foreground">{entry.id}</span>
          {entry.data?.instance && (
            <span className="text-[10px] px-1.5 py-px rounded bg-secondary text-muted-foreground font-medium flex-shrink-0 ml-2">
              {entry.data.instance}
            </span>
          )}
        </div>
      )}

      {/* Row 3: Running = latest log, Failed = error, Pending/Done = nothing */}
      {isRunning && entry.lastLogMessage && (
        <div className="font-mono text-xs text-muted-foreground mt-1.5 truncate">
          {entry.lastLogMessage}
        </div>
      )}
      {isFailed && entry.error && (
        <div className="flex items-center gap-1.5 font-mono text-xs text-destructive mt-1.5">
          <X className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{entry.error}</span>
        </div>
      )}

      {/* Row 4: Date, run number, elapsed */}
      {!isPending && (
        <div className="flex items-center gap-2 mt-1.5 text-xs font-mono text-muted-foreground">
          <span>{time}</span>
          <span className="bg-secondary px-1.5 py-px rounded font-medium">#{runNumber}</span>
          <span className="flex-1" />
          {isRunning && elapsed && (
            <span className="text-primary">{elapsed}</span>
          )}
          {(isDone || isFailed) && (
            <span>{duration || ""}</span>
          )}
        </div>
      )}
    </div>
  );
}
