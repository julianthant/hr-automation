import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Clock,
  CircleSlash,
  X,
  Ban,
  SearchX,
} from "lucide-react";
import { memo, type ComponentType, type SVGProps } from "react";
import type { TrackerEntry } from "@/components/shared/types";
import { resolveEntryId, resolveEntryName } from "@/components/shared/entry-display";
import { useElapsed, formatDuration } from "@/components/hooks/useElapsed";
import { RetryButton } from "@/components/shared/RetryButton";
import { DeleteButton } from "@/components/shared/DeleteButton";
import { isTerminalNotFoundEntry } from "../../../domain/tracker-terminal-display.js";
import { QueueItemControls } from "./QueueItemControls";
import { CancelRunningButton } from "./CancelRunningButton";

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
  // Distinct from generic `failed` — surfaced via `step === "cancelled"`.
  // Renders amber (matches the warning/cancel intent) so the user can tell at
  // a glance which failures are intentional cancellations vs unintended bugs.
  cancelled: {
    badge: "bg-[#fbbf24]/12 text-[#fbbf24] border border-[#fbbf24]/40",
    icon: Ban,
    iconClass: "",
    iconColor: "text-[#fbbf24]",
    label: "Cancelled",
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
  /** EID lookup / Active Check — UCPath had no matching row (tracker status is still `done`). */
  notFound: {
    badge: "bg-secondary/90 text-muted-foreground border border-border/80",
    icon: SearchX,
    iconClass: "",
    iconColor: "text-muted-foreground",
    label: "Not found",
  },
};

interface EntryItemProps {
  entry: TrackerEntry;
  /** Per-entry "<base> <ordinal>" labels from `buildDisplayNameMap`. */
  displayNames?: Map<string, string>;
  selected: boolean;
  /**
   * Stable selection callback — receives `entry.id`. EntryItem composes the
   * call internally so parents can pass a useCallback-stable handler without
   * minting a fresh inline closure per row each render. Pairs with the
   * `React.memo` wrapper below to avoid re-rendering 50+ rows on every SSE tick.
   */
  onSelect: (id: string) => void;
  /** The tracker date this entry belongs to — passed to DeleteButton. */
  date?: string;
  /** Called after a successful hard-delete so the parent can remove the row. */
  onDelete?: (id: string) => void;
}

function EntryItemImpl({ entry, displayNames, selected, onSelect, date, onDelete }: EntryItemProps) {
  const resolvedName = resolveEntryName(entry, displayNames);
  // `step === "cancelled"` overrides the generic `failed` status so the row
  // renders amber/Ban instead of red/AlertTriangle. The data model is still
  // `status: "failed"` (one tracker enum, no schema change) — `step` is the
  // discriminator. Kernel writes step="cancelled" via Stepper.step's pre-emit
  // when the daemon's cancel flag is set; cancel-queued's handler does the
  // same on a queued item.
  const isCancelled = entry.status === "failed" && entry.step === "cancelled";
  // Cancelled entries: prefer entry.id over an ordinal label ("Active Check 1")
  // when they differ — the concrete identifier is more useful than a sequence
  // number once the run is terminal, and it avoids duplicating the value in
  // both the header and the footer.
  const name = isCancelled && entry.id && entry.id !== resolvedName ? entry.id : resolvedName;
  const isRunning = entry.status === "running";
  const isFailed = entry.status === "failed" && !isCancelled;
  const isDone = entry.status === "done";
  const isPending = entry.status === "pending";
  const isNotFoundTerminal = isDone && isTerminalNotFoundEntry(entry);
  const cfg = isCancelled
    ? STATUS_CONFIG.cancelled
    : isNotFoundTerminal
      ? STATUS_CONFIG.notFound
      : STATUS_CONFIG[entry.status] ?? STATUS_CONFIG.pending;
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

  const subject = typeof entry.data?.__subject === "string" ? entry.data.__subject : undefined;
  const footerSecondaryId = resolveEntryId(entry);
  const showLiveRow = (isFailed && entry.error) || (isRunning && entry.lastLogMessage);

  const activeCheckStatus =
    entry.workflow === "active-check" && typeof entry.data?.activeStatus === "string"
      ? entry.data.activeStatus
      : null;
  /** UCPath-active rows: HDH-accepted uses `active`; others use `non-hdh` (still not inactive). */
  const activeCheckTag =
    activeCheckStatus === "inactive"
      ? {
          text: "IA",
          title: "Inactive",
          className: "bg-[#fbbf24]/12 text-[#fbbf24] border border-[#fbbf24]/30",
        }
      : activeCheckStatus === "active" ||
          activeCheckStatus === "non-hdh" ||
          (isDone && entry.data?.isActive === "true")
        ? {
            text: "A",
            title: activeCheckStatus === "non-hdh" ? "Active (non-HDH dept)" : "Active",
            className: "bg-[#4ade80]/12 text-[#4ade80] border border-[#4ade80]/30",
          }
        : null;

  return (
    <div className="px-3 pt-2 first:pt-3">
      <div
        onClick={() => onSelect(entry.id)}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={
          activeCheckTag
            ? `${name || entry.id} — ${activeCheckTag.title.toLowerCase()}, ${cfg.label.toLowerCase()}`
            : `${name || entry.id} — ${cfg.label.toLowerCase()}`
        }
        data-queue-entry-id={entry.id}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(entry.id);
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
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {activeCheckTag && (
                <span
                  title={activeCheckTag.title}
                  className={cn(
                    "text-[10px] font-semibold px-1.5 py-0.5 rounded-md font-sans tabular-nums",
                    activeCheckTag.className,
                  )}
                >
                  {activeCheckTag.text}
                </span>
              )}
              <span
                className={cn(
                  "text-[10px] font-medium px-2 py-0.5 rounded-md font-sans tracking-wide",
                  cfg.badge,
                )}
              >
                {cfg.label}
              </span>
            </div>
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
          {footerSecondaryId && footerSecondaryId !== name && (
            <span
              className="truncate text-foreground/80 flex-shrink min-w-0 tabular-nums"
              title={footerSecondaryId}
            >
              {footerSecondaryId}
            </span>
          )}
          <span className="flex-1" />
          {isRunning && elapsed && (
            <span className="text-primary tabular-nums flex-shrink-0">{elapsed}</span>
          )}
          {(isDone || isFailed) && duration && (
            <span className="tabular-nums flex-shrink-0">{duration}</span>
          )}
          {(isFailed || isCancelled) && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <RetryButton workflow={entry.workflow} id={entry.id} runId={entry.runId} />
              {onDelete && date && (
                <DeleteButton workflow={entry.workflow} id={entry.id} date={date} onDeleted={onDelete} />
              )}
            </div>
          )}
          {isDone && onDelete && date && (
            <DeleteButton
              workflow={entry.workflow}
              id={entry.id}
              date={date}
              onDeleted={onDelete}
              className="flex-shrink-0"
            />
          )}
          {isRunning && entry.runId && (
            <CancelRunningButton
              workflow={entry.workflow}
              id={entry.id}
              runId={entry.runId}
              subject={subject}
              entry={entry}
              className="flex-shrink-0 ml-1"
            />
          )}
          {isPending && (
            <QueueItemControls
              workflow={entry.workflow}
              id={entry.id}
              runId={entry.runId}
              subject={subject}
              className="flex-shrink-0 ml-1"
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Memoized export. Queue rows re-render on every SSE tick (1–5 Hz) when the
 * parent entries array shifts; without memoization that's 50+ subtree
 * re-renders per second. The custom comparator hand-checks the fields
 * EntryItem actually reads from `entry` (status, step, timestamps, runId,
 * runOrdinal, parentRunId, error, last-log fields, data ref) plus the three
 * other props. Returning `true` skips the render.
 *
 * Note: `data` is compared by reference. The tracker pipeline merges patches
 * into a fresh object via `{...prev, ...patch}` (see ctx.updateData), so a
 * new reference reliably signals a real change. If a producer ever mutates
 * `data` in place this will become stale — that would be a bug at the
 * source, not here.
 */
export const EntryItem = memo(EntryItemImpl, (prev, next) => {
  if (prev.selected !== next.selected) return false;
  if (prev.onSelect !== next.onSelect) return false;
  if (prev.onDelete !== next.onDelete) return false;
  if (prev.date !== next.date) return false;
  if (prev.displayNames !== next.displayNames) return false;
  const a = prev.entry;
  const b = next.entry;
  return (
    a.id === b.id &&
    a.workflow === b.workflow &&
    a.status === b.status &&
    a.step === b.step &&
    a.timestamp === b.timestamp &&
    a.startTimestamp === b.startTimestamp &&
    a.runId === b.runId &&
    a.runOrdinal === b.runOrdinal &&
    a.parentRunId === b.parentRunId &&
    a.error === b.error &&
    a.lastLogMessage === b.lastLogMessage &&
    a.firstLogTs === b.firstLogTs &&
    a.lastLogTs === b.lastLogTs &&
    a.data === b.data
  );
});
