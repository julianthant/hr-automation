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
  ClipboardList,
} from "lucide-react";
import { memo, type ComponentType, type SVGProps } from "react";
import type { TrackerEntry } from "@/components/shared/types";
import {
  formatEntryTime,
  getRunNumber,
  resolveEntryId,
  resolveEntryName,
} from "@/components/shared/entry-display";
import { useElapsed, formatDuration } from "@/components/hooks/useElapsed";
import { QueueRowCard } from "./QueueRowCard";
import { resolveQueueRowStatus } from "../../../domain/queue-row-status.js";
// Side-effect import: registers each workflow's status extensions into the
// queue-row-status registry for the client bundle (defineWorkflow doesn't run
// here). Keep this even though no symbol is used directly.
import "../../../domain/queue-row-status-index.js";
import type {
  WorkflowActionDescriptor,
  WorkflowRunProjection,
} from "../../../domain/workflow-runtime/types.js";

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
    badge: "bg-success/12 text-success border border-success/30",
    icon: CheckCircle2,
    iconClass: "",
    iconColor: "text-success",
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
    badge: "bg-warning/12 text-warning border border-warning/40",
    icon: Ban,
    iconClass: "",
    iconColor: "text-warning",
    label: "Cancelled",
  },
  pending: {
    badge: "bg-warning/12 text-warning border border-warning/30",
    icon: Clock,
    iconClass: "",
    iconColor: "text-warning",
    label: "Queued",
  },
  skipped: {
    badge: "bg-secondary text-muted-foreground border border-border",
    icon: CircleSlash,
    iconClass: "",
    iconColor: "text-muted-foreground",
    label: "Skipped",
  },
  /** Delegated OCR only (`parentRunId`) — trackers use `status: done` + `awaiting-approval`. */
  needsReview: {
    badge: "bg-info/12 text-info border border-info/35",
    icon: ClipboardList,
    iconClass: "",
    iconColor: "text-info",
    label: "Needs review",
  },
  /** Person Lookup — UCPath had no matching row (tracker status is still `done`). */
  notFound: {
    badge: "bg-secondary/90 text-muted-foreground border border-border/80",
    icon: SearchX,
    iconClass: "",
    iconColor: "text-muted-foreground",
    label: "Not found",
  },
};

/**
 * Universal status resolution. The `cancelled` override (failed + step
 * "cancelled") and the five base statuses live here because they apply to every
 * workflow. Workflow-specific *derived* statuses (person-lookup `notFound`, OCR
 * `needsReview`) arrive pre-resolved as `derivedStatus` from
 * `resolveQueueRowStatus` — this component never names a workflow.
 */
function resolveStatusConfig(entry: TrackerEntry, derivedStatus: string | null): StatusConfig {
  if (entry.status === "failed" && entry.step === "cancelled") {
    return STATUS_CONFIG.cancelled;
  }
  if (derivedStatus && STATUS_CONFIG[derivedStatus]) {
    return STATUS_CONFIG[derivedStatus];
  }
  return STATUS_CONFIG[entry.status] ?? STATUS_CONFIG.pending;
}

interface EntryItemProps {
  entry: TrackerEntry;
  projection?: WorkflowRunProjection;
  title?: string;
  subtitle?: string;
  statusLabel?: string;
  actions?: WorkflowActionDescriptor[];
  /** Per-entry base-name labels from `buildDisplayNameMap`. */
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

function EntryItemImpl({
  entry,
  projection,
  title,
  subtitle,
  statusLabel,
  actions,
  displayNames,
  selected,
  onSelect,
  date,
  onDelete,
}: EntryItemProps) {
  const resolvedName = resolveEntryName(entry, displayNames);
  // `step === "cancelled"` overrides the generic `failed` status so the row
  // renders amber/Ban instead of red/AlertTriangle. The data model is still
  // `status: "failed"` (one tracker enum, no schema change) — `step` is the
  // discriminator. Kernel writes step="cancelled" via Stepper.step's pre-emit
  // when the daemon's cancel flag is set; cancel-queued's handler does the
  // same on a queued item.
  // Workflow-specific status — resolved generically. `derivedStatus`
  // (notFound / needsReview) replaces the base badge; `secondaryTag` (A/IA)
  // renders alongside it. EntryItem stays workflow-agnostic: the per-workflow
  // rules live in each workflow's `statusExtensions` declaration.
  const derivedStatus = resolveQueueRowStatus(entry, { isDone: false }).derivedStatus;
  const isOcrDelegatedNeedsReview = derivedStatus === "needsReview";
  const isDaemonRunning = entry.status === "running";
  const isCancelled = entry.status === "failed" && entry.step === "cancelled";
  const projectedActions = projection?.actions ?? actions;
  const name = projection?.title ?? title ?? resolvedName;
  const isFailed = entry.status === "failed" && !isCancelled;
  const isDone = entry.status === "done" && !isOcrDelegatedNeedsReview;
  const isPending = entry.status === "pending";
  const cfg = resolveStatusConfig(entry, derivedStatus);
  const StatusIcon = cfg.icon;

  const firstTs = entry.firstLogTs || entry.startTimestamp || entry.timestamp;
  const lastTs = entry.lastLogTs || entry.timestamp;
  const elapsed = useElapsed(isDaemonRunning ? firstTs : null);
  const duration =
    (isDone || isFailed || isOcrDelegatedNeedsReview) && firstTs !== lastTs
      ? formatDuration(firstTs, lastTs)
      : null;

  const runNumber = getRunNumber(entry);
  const time = entry.firstLogTs || entry.timestamp
    ? formatEntryTime(entry.firstLogTs || entry.timestamp)
    : "";

  // Run-mode preset chip — present only when the row was started with a
  // non-default preset via the InputRunPanel gear menu. Read from the kernel-
  // stamped `data.__preset` (set at runOneItem startup).
  const presetId = typeof entry.data?.__preset === "string" ? entry.data.__preset : undefined;
  const footerSecondaryId = projection?.subtitle ?? subtitle ?? resolveEntryId(entry);
  const showLiveRow =
    (isFailed && Boolean(entry.error)) ||
    Boolean(
      (isDaemonRunning || isPending || isOcrDelegatedNeedsReview) && entry.lastLogMessage,
    );

  const personLookupStatusTag = resolveQueueRowStatus(entry, { isDone }).secondaryTag;

  return (
    <QueueRowCard
      selected={selected}
      rootProps={{
        onClick: () => onSelect(entry.id),
        role: "button",
        tabIndex: 0,
        "aria-pressed": selected,
        "aria-label": personLookupStatusTag
          ? `${name || entry.id} — ${personLookupStatusTag.title.toLowerCase()}, ${cfg.label.toLowerCase()}`
          : `${name || entry.id} — ${(statusLabel ?? cfg.label).toLowerCase()}`,
        "data-queue-entry-id": entry.id,
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(entry.id);
          }
        },
        // Subtle running-state border tint, layered over the card chrome.
        className: cn(isDaemonRunning && "border-primary/30"),
      }}
      footer={{
        time,
        runNumber,
        secondaryId: footerSecondaryId,
        suppressIdWhenEquals: name,
        // needsReview is awaiting-approval (status "running" but not actively
        // running) — show its frozen duration, not a live elapsed timer.
        elapsed: isDaemonRunning && !isOcrDelegatedNeedsReview ? elapsed : null,
        duration: isDone || isFailed || isOcrDelegatedNeedsReview ? duration : null,
        rowAction: {
          workflow: entry.workflow,
          id: entry.id,
          runId: entry.runId,
          date,
          actions: projectedActions,
          entry,
          subject: name || entry.id,
          onDelete,
        },
      }}
    >
      {/* Header zone — name + status badge, optional live log inside */}
      <div className="px-3.5 py-2.5">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <StatusIcon
              aria-hidden
              className={cn("w-3.5 h-3.5 shrink-0", cfg.iconClass, cfg.iconColor)}
            />
            <span className="font-semibold text-[14px] text-foreground truncate">
              {name || entry.id}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {presetId && (
              <span
                title={`Run mode: ${presetId}`}
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md font-sans bg-primary/15 text-primary"
              >
                {presetId}
              </span>
            )}
            {personLookupStatusTag && (
              <span
                title={personLookupStatusTag.title}
                className={cn(
                  "text-[10px] font-semibold px-1.5 py-0.5 rounded-md font-sans tabular-nums",
                  personLookupStatusTag.className,
                )}
              >
                {personLookupStatusTag.text}
              </span>
            )}
            <span
              className={cn(
                "text-[10px] font-medium px-2 py-0.5 rounded-md font-sans tracking-wide",
                cfg.badge,
              )}
            >
              {statusLabel ?? cfg.label}
            </span>
          </div>
        </div>

        {showLiveRow && (
          <div className="mt-1.5 ml-5 text-[11px] font-mono min-w-0">
            {isFailed && entry.error ? (
              <span className="flex items-center gap-1.5 text-destructive truncate min-w-0">
                <X className="w-3 h-3 shrink-0" aria-hidden />
                <span className="truncate">{entry.error}</span>
              </span>
            ) : (
              <span className="text-primary/85 truncate block">{entry.lastLogMessage}</span>
            )}
          </div>
        )}
      </div>
    </QueueRowCard>
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
  if (prev.projection !== next.projection) return false;
  if (prev.title !== next.title) return false;
  if (prev.subtitle !== next.subtitle) return false;
  if (prev.statusLabel !== next.statusLabel) return false;
  if (prev.actions !== next.actions) return false;
  return prev.entry._hash === next.entry._hash;
});
