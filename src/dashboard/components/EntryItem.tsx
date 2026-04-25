import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import type { TrackerEntry } from "./types";
import { resolveEntryName } from "./entry-display";
import { useElapsed, formatDuration } from "./hooks/useElapsed";
import { RetryButton } from "./RetryButton";
import { QueueItemControls } from "./QueueItemControls";

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

  // Row 2 identifiers:
  //   - eid-lookup stamps `data.emplId` (verbatim "Not found" / "Error" kept
  //     so the operator can distinguish "we searched and missed" from "still
  //     running").
  //   - separations stamps `data.docId` (Kuali document number) immediately
  //     and `data.eid` after kuali-extraction.
  const emplId = entry.data?.emplId;
  const docId = entry.data?.docId;
  const eid = entry.data?.eid;

  return (
    <div
      onClick={onClick}
      className={cn(
        "h-[82px] px-5 py-2.5 border-b border-border cursor-pointer transition-colors flex flex-col justify-between gap-1.5 overflow-hidden leading-tight",
        "hover:bg-secondary",
        selected && "bg-accent border-r-[3px] border-r-primary pr-[17px]",
      )}
    >
      {/* Row 1: Name (+ Doc # for separations) + status badge. The Doc #
          trails the name as a smaller muted-foreground mono chip — no
          label, just the number — so the operator can tell rows apart at
          a glance without shifting to Row 2. */}
      <div className="flex items-center justify-between min-w-0 gap-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-semibold text-[14px] truncate">{name || entry.id}</span>
          {docId && (
            <span className="text-[11px] font-mono text-muted-foreground flex-shrink-0" title={docId}>
              {docId}
            </span>
          )}
        </div>
        <span className={cn("text-[10px] font-semibold px-2.5 py-0.5 rounded-xl uppercase tracking-wide font-mono flex-shrink-0", badgeStyles[entry.status])}>
          {entry.status}
        </span>
      </div>

      {/* Row 2: live log message (running) or error (failed). Takes the
          slot previously occupied by the EID row so operators see the
          most current activity directly under the name. */}
      {(isFailed && entry.error) || (isRunning && entry.lastLogMessage) ? (
        <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground min-w-0">
          {isFailed && entry.error ? (
            <span className="flex items-center gap-1 text-destructive truncate min-w-0">
              <X className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{entry.error}</span>
            </span>
          ) : (
            <span className="truncate min-w-0">{entry.lastLogMessage}</span>
          )}
        </div>
      ) : null}

      {/* Row 3: time + run + EID (eid-lookup stamps `data.emplId`;
          separations stamps `data.eid`) + elapsed/duration. EID moved
          beside the run chip so all identifiers cluster in the
          time/meta row. */}
      <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground min-w-0">
        <span className="flex-shrink-0">{time}</span>
        <span className="bg-secondary px-1.5 py-px rounded font-medium flex-shrink-0">#{runNumber}</span>
        {(emplId || eid) && (
          <span className="truncate text-foreground flex-shrink min-w-0" title={emplId || eid}>
            {emplId || eid}
          </span>
        )}
        <span className="flex-1" />
        {isRunning && elapsed && (
          <span className="text-primary flex-shrink-0">{elapsed}</span>
        )}
        {(isDone || isFailed) && duration && (
          <span className="flex-shrink-0">{duration}</span>
        )}
        {/* Inline ops controls — failed rows get retry; pending rows get
            cancel + bump. Stop event propagation inside the buttons so
            the row's onClick (selecting the entry) doesn't fire. */}
        {isFailed && (
          <RetryButton workflow={entry.workflow} id={entry.id} className="flex-shrink-0 ml-1" />
        )}
        {isPending && (
          <QueueItemControls workflow={entry.workflow} id={entry.id} className="flex-shrink-0 ml-1" />
        )}
      </div>
    </div>
  );
}
