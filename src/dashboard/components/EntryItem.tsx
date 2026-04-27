import { cn } from "@/lib/utils";
import { CheckCircle2, AlertTriangle, Loader2, Clock, CircleSlash, X } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import type { TrackerEntry } from "./types";
import { resolveEntryName } from "./entry-display";
import { useElapsed, formatDuration } from "./hooks/useElapsed";
import { RetryButton } from "./RetryButton";
import { QueueItemControls } from "./QueueItemControls";

// Bento-card row. Each entry is a tonal `bg-card` panel with rounded
// corners, an internal divider splitting the header zone (name + status
// badge + optional live log) from the footer zone (time, run #, EID,
// duration, inline ops). Hover lifts with a soft shadow + border glow;
// selection uses ring-2 ring-primary instead of a bg shift so it pops
// against neighbouring cards.

interface StatusConfig {
  badge: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  iconClass: string;
  iconColor: string;
  label: string;
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  running: {
    badge: "bg-primary/15 text-primary border border-primary/30",
    icon: Loader2,
    iconClass: "animate-spin motion-reduce:animate-none",
    iconColor: "text-primary",
    label: "Running",
  },
  done: {
    badge: "bg-[#4ade80]/12 text-[#4ade80] border border-[#4ade80]/30",
    icon: CheckCircle2,
    iconClass: "",
    iconColor: "text-[#4ade80]",
    label: "Done",
  },
  failed: {
    badge: "bg-destructive/12 text-destructive border border-destructive/30",
    icon: AlertTriangle,
    iconClass: "",
    iconColor: "text-destructive",
    label: "Failed",
  },
  pending: {
    badge: "bg-[#fbbf24]/12 text-[#fbbf24] border border-[#fbbf24]/30",
    icon: Clock,
    iconClass: "",
    iconColor: "text-[#fbbf24]",
    label: "Queued",
  },
  skipped: {
    badge: "bg-secondary text-muted-foreground border border-border",
    icon: CircleSlash,
    iconClass: "",
    iconColor: "text-muted-foreground",
    label: "Skipped",
  },
};

interface EntryItemProps {
  entry: TrackerEntry;
  selected: boolean;
  onClick: () => void;
}

export function EntryItem({ entry, selected, onClick }: EntryItemProps) {
  const name = resolveEntryName(entry);
  const isRunning = entry.status === "running";
  const isFailed = entry.status === "failed";
  const isDone = entry.status === "done";
  const isPending = entry.status === "pending";
  const cfg = STATUS_CONFIG[entry.status] ?? STATUS_CONFIG.pending;
  const StatusIcon = cfg.icon;

  const firstTs = entry.firstLogTs || entry.startTimestamp || entry.timestamp;
  const lastTs = entry.lastLogTs || entry.timestamp;
  const elapsed = useElapsed(isRunning ? firstTs : null);
  const duration =
    (isDone || isFailed) && firstTs !== lastTs ? formatDuration(firstTs, lastTs) : null;

  let runNumber: number;
  if (typeof entry.runOrdinal === "number" && entry.runOrdinal > 0) {
    runNumber = entry.runOrdinal;
  } else {
    const parsed = Number.parseInt(entry.runId?.split("#")[1] ?? "", 10);
    runNumber = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }
  const time = entry.firstLogTs || entry.timestamp
    ? new Date(entry.firstLogTs || entry.timestamp).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

  const emplId = entry.data?.emplId;
  const docId = entry.data?.docId;
  const eid = entry.data?.eid;
  const showLiveRow = (isFailed && entry.error) || (isRunning && entry.lastLogMessage);

  return (
    <div className="px-3 pt-2 first:pt-3">
      <div
        onClick={onClick}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={`${name || entry.id} — ${cfg.label.toLowerCase()}`}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
        className={cn(
          "group relative bg-card border border-border rounded-lg cursor-pointer outline-none overflow-hidden",
          "transition-all duration-200",
          "hover:border-primary/40 hover:shadow-lg hover:shadow-black/20",
          "focus-visible:ring-2 focus-visible:ring-primary",
          selected && "ring-2 ring-primary border-primary/50 shadow-lg shadow-black/20",
          isRunning && "border-primary/30",
        )}
      >
        {/* Header zone — name + status badge, optional live log inside */}
        <div className="px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <StatusIcon
                aria-hidden
                className={cn("w-3.5 h-3.5 flex-shrink-0", cfg.iconClass, cfg.iconColor)}
              />
              <span className="font-semibold text-[14px] text-foreground truncate">
                {name || entry.id}
              </span>
              {docId && (
                <span className="text-[11px] font-mono text-muted-foreground bg-secondary px-1.5 py-px rounded flex-shrink-0 tabular-nums">
                  {docId}
                </span>
              )}
            </div>
            <span
              className={cn(
                "text-[10px] font-medium px-2 py-0.5 rounded-md font-sans tracking-wide flex-shrink-0",
                cfg.badge,
              )}
            >
              {cfg.label}
            </span>
          </div>

          {showLiveRow && (
            <div className="mt-1.5 ml-5 text-[11px] font-mono min-w-0">
              {isFailed && entry.error ? (
                <span className="flex items-center gap-1.5 text-destructive truncate min-w-0">
                  <X className="w-3 h-3 flex-shrink-0" aria-hidden />
                  <span className="truncate">{entry.error}</span>
                </span>
              ) : (
                <span className="text-primary/85 truncate block">{entry.lastLogMessage}</span>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-border/60" />

        {/* Footer zone — meta + inline ops, slightly tinted */}
        <div className="px-3.5 py-1.5 bg-secondary/20 flex items-center gap-2 text-[11px] font-mono text-muted-foreground min-w-0">
          <span className="tabular-nums flex-shrink-0">{time}</span>
          <span className="bg-secondary/80 px-1.5 py-px rounded font-medium flex-shrink-0 tabular-nums">
            #{runNumber}
          </span>
          {(emplId || eid) && (
            <span
              className="truncate text-foreground/80 flex-shrink min-w-0 tabular-nums"
              title={emplId || eid}
            >
              {emplId || eid}
            </span>
          )}
          <span className="flex-1" />
          {isRunning && elapsed && (
            <span className="text-primary tabular-nums flex-shrink-0">{elapsed}</span>
          )}
          {(isDone || isFailed) && duration && (
            <span className="tabular-nums flex-shrink-0">{duration}</span>
          )}
          {isFailed && (
            <RetryButton
              workflow={entry.workflow}
              id={entry.id}
              className="flex-shrink-0 ml-1"
            />
          )}
          {isPending && (
            <QueueItemControls
              workflow={entry.workflow}
              id={entry.id}
              className="flex-shrink-0 ml-1"
            />
          )}
        </div>
      </div>
    </div>
  );
}
