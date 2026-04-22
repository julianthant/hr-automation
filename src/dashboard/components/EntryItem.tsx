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

  // Prefer the backend-assigned chronological ordinal — it's the only path
  // that works for UUID-format runIds (batch/pool runners). Legacy fallback
  // parses the `{id}#N` shape; final fallback is 1 so "#0" never appears.
  let runNumber: number;
  if (typeof entry.runOrdinal === "number" && entry.runOrdinal > 0) {
    runNumber = entry.runOrdinal;
  } else {
    const parsed = Number.parseInt(entry.runId?.split("#")[1] ?? "", 10);
    runNumber = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }
  const time = entry.firstLogTs || entry.timestamp
    ? new Date(entry.firstLogTs || entry.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "";

  // EID lookup: show the resolved Empl ID as a third row when it's been
  // stamped onto the entry. Populated by eid-lookup's searchingStep /
  // crossVerificationStep ("Not found" / "Error" are kept verbatim so the
  // operator can distinguish "we searched and missed" from "still running").
  const emplId = entry.data?.emplId;

  return (
    <div
      onClick={onClick}
      className={cn(
        "h-[69.5px] px-5 py-1.5 border-b border-border cursor-pointer transition-colors flex flex-col justify-evenly overflow-hidden leading-tight",
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

      {/* Row 2: EID. Rendered only when the workflow has stamped data.emplId
          (today: eid-lookup). Slotted between the name and the time/meta
          row so the resolved identifier sits visually closest to the
          operator-readable name. Uses the same mono/muted treatment as the
          detail grid so the value matches the LogPanel's EID cell. */}
      {emplId && (
        <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground min-w-0">
          <span className="uppercase tracking-wider text-[10px] flex-shrink-0">EID</span>
          <span className="truncate text-foreground" title={emplId}>{emplId}</span>
        </div>
      )}

      {/* Row 3 (or Row 2 when no EID): time + run + elapsed/duration. Kept
          within the 69.5px slot that lines up with the LogPanel's
          detail-grid rows across the column gap; padding/leading tightened
          to make room for the EID row when eid-lookup has stamped one. */}
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
