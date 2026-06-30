import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Clock,
  FileSearch,
  Loader2,
  ArrowUpRight,
  type LucideIcon,
} from "lucide-react";
import { OperationCancelButton } from "./OperationCancelButton";
import { useMemo, useState, type ReactNode } from "react";
import type { TrackerEntry } from "@/components/shared/types";
import type { WorkflowRunProjection } from "../../../domain/workflow-runtime/types.js";
import type { OperationOcrLink } from "./queue-surface-classifier";
import { QueueRowCard } from "./QueueRowCard";
import { EntryItem } from "./EntryItem";
import { StatusCounts } from "./StatusCounts";
import {
  formatEntryTime,
  getRunNumber,
  resolveEntryId,
  resolveEntryName,
  resolveQueueRowLiveMessage,
} from "@/components/shared/entry-display";
import { useElapsed, formatDuration } from "@/components/hooks/useElapsed";
import {
  aggregateOperationCounts,
  pickPreviewChildren,
} from "@/components/ocr/delegation-row-helpers";
import { statusKeyForEntry } from "@/components/shared/status-styles";
import { cn } from "@/lib/utils";

/**
 * Unified operation coordinator card — used by `OperationRow.tsx` and the
 * dev UI gallery (`?view=ui-gallery`).
 *
 * The coordinator is ONE card (via QueueRowCard). Order is:
 *
 *     header (pdf + status; awaiting-review adds OCR jump beside badge)
 *     ── work zone ──            ← active OCR prep strip OR member section
 *     ── footer ──               ← time · #run · id · elapsed · actions
 *
 * The footer is the card's true bottom edge; nothing dangles under it. After
 * approval the work zone holds a summary toggle (per-status tally) above the
 * footer; expanding it reveals the fanned-out members as full `EntryItem`
 * single rows (each keeps its own status + footer actions).
 */

export interface OperationRowUnifiedProps {
  date?: string;
  parentRunId: string;
  projection?: WorkflowRunProjection;
  displayNames?: Map<string, string>;
  parent: TrackerEntry;
  members: TrackerEntry[];
  ocr?: OperationOcrLink;
  selected: boolean;
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  defaultExpanded?: boolean;
  onOpenOcrReview?: (target: { sessionId: string; runId: string }) => void;
  /** Optional content above member EntryItems when expanded (UI gallery nesting demos). */
  expandedExtra?: ReactNode;
}

// ---------------------------------------------------------------------------
// Coordinator header status (mirrors EntryItem's STATUS_CONFIG).
// ---------------------------------------------------------------------------

interface HeaderStatus {
  badge: string;
  icon: LucideIcon;
  iconClass: string;
  iconColor: string;
  label: string;
}

const HEADER_STATUS: Record<string, HeaderStatus> = {
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
  /** Denormalized OCR gate — mirrors EntryItem `needsReview`. */
  needsReview: {
    badge: "bg-info/12 text-info border border-info/35",
    icon: ClipboardList,
    iconClass: "",
    iconColor: "text-info",
    label: "awaiting review",
  },
};

/** Per-member status icons for the collapsed member-name preview — mirrors group-row-base's STATUS_ICON. */
const MEMBER_PREVIEW_ICON: Record<
  string,
  { Icon: LucideIcon; color: string; spin: boolean }
> = {
  running: { Icon: Loader2, color: "text-primary", spin: true },
  pending: { Icon: Clock, color: "text-warning", spin: false },
  done: { Icon: CheckCircle2, color: "text-success", spin: false },
  skipped: { Icon: CheckCircle2, color: "text-success", spin: false },
  failed: { Icon: AlertTriangle, color: "text-destructive", spin: false },
};

/**
 * True when the resolved operation header title is non-empty (titled variant).
 * False for a person-kind anchor whose `operationGroupTitle` returns `""` — in that
 * case there is no header strip at all; the card starts at the count badge and
 * the expandable member rows below identify the operation.
 *
 * Extracted as a pure helper so it can be tested without mounting React.
 */
export function operationHeaderHasTitle(name: string): boolean {
  return name.trim().length > 0;
}

function headerStatus(entry: TrackerEntry, ocr?: OperationOcrLink): HeaderStatus {
  if (ocr?.status === "awaiting-review") return HEADER_STATUS.needsReview;
  // `statusKeyForEntry` applies the shared failed+cancelled override so the
  // coordinator header amber-renders a cancelled run like every other surface.
  return HEADER_STATUS[statusKeyForEntry(entry)] ?? HEADER_STATUS.pending;
}

/**
 * The status label used for both the visible chip AND the `aria-label` on the
 * coordinator card's root button. Extracted as a pure function so it can be
 * tested without mounting the React component.
 *
 * The label must be derived from the SAME source as the chip — `headerStatus`
 * which promotes `ocr.status === "awaiting-review"` to the `needsReview`
 * config ("awaiting review"). Using the raw `entry.status` would say "running"
 * while the chip shows "awaiting review", breaking a11y parity (ISS-001).
 */
export function resolveOperationStatusLabel(
  entry: TrackerEntry,
  ocr: OperationOcrLink | undefined,
): string {
  return headerStatus(entry, ocr).label;
}

function isAwaitingOcrReview(ocr?: OperationOcrLink): boolean {
  return ocr?.status === "awaiting-review";
}

function statusForDisplay(
  parent: TrackerEntry,
  projection: WorkflowRunProjection | undefined,
): TrackerEntry {
  if (!projection?.status || projection.status === parent.status) return parent;
  return {
    ...parent,
    status: projection.status as TrackerEntry["status"],
    _hash: `${parent._hash ?? parent.id}:${projection.status}`,
  };
}

// ---------------------------------------------------------------------------
// The unified coordinator card.
// ---------------------------------------------------------------------------

export function OperationRowUnified({
  date,
  parentRunId,
  projection,
  displayNames,
  parent,
  members,
  ocr,
  selected,
  selectedId,
  onSelect,
  onDelete,
  defaultExpanded = false,
  onOpenOcrReview,
  expandedExtra,
}: OperationRowUnifiedProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Selection model: the card root (header + the gaps between rows) selects the
  // MAIN coordinator row (the "event tracker"). A MEMBER row — a collapsed
  // member-preview row OR an expanded member EntryItem — selects THAT member
  // instead, so the operator can open one signer/contact's own logs. Member
  // clicks therefore `stopPropagation` (so the bubble doesn't re-select the
  // coordinator at the card root) and route `onSelect(member.id)`. The
  // count-strip header still toggles collapse (stopPropagation below).
  const displayParent = statusForDisplay(parent, projection);
  const awaitingReview = isAwaitingOcrReview(ocr);
  const cfg = headerStatus(displayParent, ocr);
  const StatusIcon = cfg.icon;

  const counts = useMemo(() => aggregateOperationCounts(members), [members]);
  // Non-terminal members = running + queued; when any exist the coordinator
  // shows a "Cancel remaining" button to cancel the whole fan-out at once
  // (E2E-102). When all members are terminal the button hides automatically.
  const hasNonTerminalMembers = counts.running + counts.queued > 0;
  const memberProjectionById = useMemo(
    () => new Map((projection?.operationMembers ?? []).map((m) => [m.itemId, m])),
    [projection?.operationMembers],
  );
  const showOcrWorkZone = members.length === 0 && Boolean(ocr) && !awaitingReview;
  const ocrSessionId = ocr?.sessionId;
  const ocrRunId = ocr?.runId;
  const canOpenOcr = Boolean(ocrSessionId && ocrRunId && onOpenOcrReview);

  const name = projection?.title ?? resolveEntryName(displayParent, displayNames);
  const hasTitle = operationHeaderHasTitle(name);
  const previewKids = pickPreviewChildren(members, 3);
  const isActivelyRunning = displayParent.status === "running" && !awaitingReview;
  const isTerminal = displayParent.status === "done" || displayParent.status === "failed";
  const subline = awaitingReview
    ? null
    : isActivelyRunning
      ? resolveQueueRowLiveMessage(parent)
      : displayParent.status === "failed"
        ? resolveQueueRowLiveMessage(parent)
        : null;

  const firstTs = parent.firstLogTs || parent.startTimestamp || parent.timestamp;
  const lastTs = parent.lastLogTs || parent.timestamp;
  const elapsed = useElapsed(isActivelyRunning ? firstTs : null);
  const duration =
    (isTerminal || awaitingReview) && firstTs !== lastTs ? formatDuration(firstTs, lastTs) : null;

  return (
    <div data-queue-operation-run-id={parentRunId}>
      <QueueRowCard
        selected={selected}
        rootProps={{
          onClick: () => onSelect(parent.id),
          role: "button",
          tabIndex: 0,
          "aria-pressed": selected,
          "aria-label": hasTitle
            ? `${name} — ${resolveOperationStatusLabel(displayParent, ocr).toLowerCase()}`
            : `${counts.total} ${counts.total === 1 ? "document" : "documents"} — ${resolveOperationStatusLabel(displayParent, ocr).toLowerCase()}`,
          "data-queue-entry-id": parent.id,
          onKeyDown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(parent.id);
            }
          },
          className: cn(
            isActivelyRunning && "border-primary/30",
            displayParent.status === "failed" && "border-destructive/30",
          ),
        }}
        footer={{
          time: formatEntryTime(parent.firstLogTs || parent.timestamp),
          runNumber: getRunNumber(parent),
          secondaryId: projection?.subtitle ?? resolveEntryId(parent),
          // For titled coordinators suppress the footer id when it matches the
          // title (avoiding redundant display). For titleless person anchors the
          // name is "", so leave suppressIdWhenEquals as "" — the trace id in
          // secondaryId is always different and will always be shown.
          suppressIdWhenEquals: name,
          elapsed: isActivelyRunning ? elapsed : null,
          duration: isTerminal || awaitingReview ? duration : null,
          // When non-terminal members exist, show the one-click "Cancel
          // remaining" tree-cancel. `actions` overrides `rowAction`'s cluster
          // — the coordinator's projection returns only groupActions (no
          // row-level cancel/retry/delete) when members are present, so the
          // normal rowAction cluster is empty anyway (E2E-102).
          ...(hasNonTerminalMembers
            ? {
                actions: (
                  <OperationCancelButton
                    workflow={parent.workflow}
                    id={parent.id}
                    runId={parent.runId}
                    subject={hasTitle ? name : `${counts.total} ${counts.total === 1 ? "document" : "documents"}`}
                  />
                ),
              }
            : {
                rowAction: {
                  workflow: parent.workflow,
                  id: parent.id,
                  runId: parent.runId,
                  date,
                  actions: projection?.actions,
                  entry: displayParent,
                  subject: hasTitle ? name : `${counts.total} ${counts.total === 1 ? "document" : "documents"}`,
                  onDelete,
                },
              }),
        }}
      >
        {/* Header zone — rendered ONLY for a titled coordinator (file-kind, e.g.
            a PDF filename). A titleless person anchor has NO header strip at all:
            the count badge + expandable member rows identify the operation, so
            the card starts directly at the count strip below. */}
        {hasTitle && (
          <div className="px-3.5 py-2.5">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <StatusIcon
                  aria-hidden
                  className={cn("h-3.5 w-3.5 shrink-0", cfg.iconClass, cfg.iconColor)}
                />
                <span className="truncate text-[14px] font-semibold text-foreground">{name}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <span
                  className={cn(
                    "rounded-md px-2 py-0.5 font-sans text-[10px] font-medium tracking-wide",
                    cfg.badge,
                  )}
                >
                  {cfg.label}
                </span>
                {awaitingReview && canOpenOcr ? (
                  <button
                    type="button"
                    aria-label="Open OCR review"
                    title="Open OCR review"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (ocrSessionId && ocrRunId && onOpenOcrReview) {
                        onOpenOcrReview({ sessionId: ocrSessionId, runId: ocrRunId });
                      }
                    }}
                    className={cn(
                      "inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-info/40 bg-info/10",
                      "text-info transition-colors duration-200",
                      "hover:border-info/60 hover:bg-info/20",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info cursor-pointer",
                    )}
                  >
                    <ArrowUpRight className="size-3" aria-hidden />
                  </button>
                ) : null}
              </div>
            </div>
            {subline && (
              <div className="ml-5 mt-1.5 min-w-0 font-mono text-[11px]">
                <span
                  className={cn(
                    "block truncate",
                    displayParent.status === "failed" ? "text-destructive" : "text-primary/85",
                  )}
                >
                  {subline}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Work zone — OCR status (pre-approval) OR member section. Sits ABOVE
            the footer, inside the same card, so the footer stays the bottom. */}
        {showOcrWorkZone && ocr && (
          <div className="flex items-center gap-2.5 border-t border-border/60 bg-secondary/15 px-3.5 py-2 text-[11.5px]">
            <FileSearch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">OCR review</span>
            {canOpenOcr && (
              <button
                type="button"
                aria-label="Open OCR review"
                title="Open OCR review"
                onClick={(event) => {
                  event.stopPropagation();
                  if (ocrSessionId && ocrRunId && onOpenOcrReview) {
                    onOpenOcrReview({ sessionId: ocrSessionId, runId: ocrRunId });
                  }
                }}
                className={cn(
                  "ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-primary/40 bg-primary/10",
                  "text-primary transition-colors duration-200",
                  "hover:border-primary/60 hover:bg-primary/20",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer",
                )}
              >
                <ArrowUpRight className="size-3" aria-hidden />
              </button>
            )}
          </div>
        )}

        {members.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={
                counts.total === 1
                  ? "1 member, expand or collapse"
                  : `${counts.total.toLocaleString()} members, expand or collapse`
              }
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((next) => !next);
              }}
              className={cn(
                "flex w-full items-center gap-2 bg-secondary/15 px-3.5 py-2 text-left transition-colors duration-150",
                // Top divider only when a header sits above; a titleless anchor
                // has no header, so the count strip is the card's top edge.
                hasTitle && "border-t border-border/60",
                "hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
              )}
            >
              {expanded ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10.5px]">
                <StatusCounts counts={counts} />
              </span>
            </button>

            {/* Collapsed: a batch-style member-name preview (running→queued→
                failed→done order via pickPreviewChildren) so the operation reads
                like a batch row at rest. Each preview row is a real button —
                clicking it selects THAT member (opening its own logs) and
                expands the card so the highlighted member row is visible. The
                chevron header still toggles collapse. Hairline dividers separate
                the rows. */}
            {!expanded && previewKids.length > 0 && (
              <div className="flex flex-col border-t border-border/40 bg-card font-mono text-[10.5px]">
                {previewKids.map((kid, i) => {
                  const kidCfg = MEMBER_PREVIEW_ICON[kid.status] ?? MEMBER_PREVIEW_ICON.pending;
                  const KidIcon = kidCfg.Icon;
                  return (
                    <button
                      key={kid.id}
                      type="button"
                      aria-label={`View ${kid.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(kid.id);
                        setExpanded(true);
                      }}
                      className={cn(
                        "flex w-full min-w-0 items-center gap-2 px-3.5 py-1.5 text-left transition-colors duration-150 cursor-pointer",
                        "hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
                        i > 0 && "border-t border-border/40",
                      )}
                    >
                      <KidIcon
                        aria-hidden
                        className={cn(
                          "h-3 w-3 shrink-0",
                          kidCfg.color,
                          kidCfg.spin && "animate-spin motion-reduce:animate-none",
                        )}
                      />
                      <span className="flex-1 truncate min-w-0 text-foreground/90">{kid.name}</span>
                      {kid.emplId && (
                        <span className="shrink-0 tabular-nums text-[9.5px] text-muted-foreground">
                          {kid.emplId}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {expanded && (
              // Members are full EntryItem single rows shown for status + their
              // own footer actions (retry/cancel/delete). Clicking a member row
              // selects THAT member (its own logs/screenshots open in the right
              // panel) via `onSelect={onSelect}`. The wrapper `stopPropagation`
              // keeps that member click from bubbling to the card root, which
              // would otherwise re-select the coordinator. Footer action buttons
              // keep their own stopPropagation, so they still act on the member.
              // Clicks on the gaps/padding are caught by the wrapper too, so
              // they no longer select anything (use the card header for that).
              <div
                className="border-t border-border/40 bg-card pb-3"
                onClick={(event) => event.stopPropagation()}
              >
                {/* Cap the inline list height so a large fan-out scrolls in
                    place instead of growing the card without bound. ~4 rows. */}
                <div className="max-h-[24rem] overflow-y-auto">
                  {expandedExtra}
                  {members.map((member) => (
                    <EntryItem
                      key={member.id}
                      entry={member}
                      projection={memberProjectionById.get(member.id)}
                      displayNames={displayNames}
                      // A selected member shows its own (muted) selection ring;
                      // the coordinator card's ring is suppressed (selected is
                      // false at the card root when a member is the selection).
                      selected={selectedId === member.id}
                      selectionTone="muted"
                      onSelect={onSelect}
                      date={date}
                      onDelete={onDelete}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </QueueRowCard>
    </div>
  );
}
