import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import type { TrackerEntry } from "./types";
import { resolveEntryName } from "./entry-display";
import { useElapsed, formatDuration } from "./hooks/useElapsed";

interface EntryItemProps {
  entry: TrackerEntry;
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

export function EntryItem({ entry, selected, onClick }: EntryItemProps) {
  const name = resolveEntryName(entry);
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
        "h-[69.5px] px-5 py-2.5 border-b border-border cursor-pointer transition-colors flex flex-col justify-center gap-1 overflow-hidden",
        "hover:bg-secondary",
        selected && "bg-accent border-r-[3px] border-r-primary pr-[17px]",
      )}
    >
      {/* Row 1: Name + status badge */}
      <div className="flex items-center justify-between min-w-0">
        <span className="font-semibold text-[14px] truncate">{name || entry.id}</span>
        <span className={cn("text-[10px] font-semibold px-2.5 py-0.5 rounded-xl uppercase tracking-wide font-mono flex-shrink-0 ml-2", badgeStyles[entry.status])}>
          {entry.status}
        </span>
      </div>

      {/* Row 2: time + run + elapsed/duration. Replaces the older 4-row
          shape so the entry fits cleanly inside the 69.5px slot that lines
          up with the LogPanel's detail-grid rows across the column gap. */}
      <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground min-w-0">
        <span className="flex-shrink-0">{time}</span>
        <span className="bg-secondary px-1.5 py-px rounded font-medium flex-shrink-0">#{runNumber}</span>
        {isFailed && entry.error ? (
          <span className="flex items-center gap-1 text-destructive truncate min-w-0">
            <X className="w-3 h-3 flex-shrink-0" />
            <span className="truncate">{entry.error}</span>
          </span>
        ) : isRunning && entry.lastLogMessage ? (
          <span className="truncate min-w-0">{entry.lastLogMessage}</span>
        ) : null}
        <span className="flex-1" />
        {isRunning && elapsed && (
          <span className="text-primary flex-shrink-0">{elapsed}</span>
        )}
        {(isDone || isFailed) && duration && (
          <span className="flex-shrink-0">{duration}</span>
        )}
      </div>
    </div>
  );
}
