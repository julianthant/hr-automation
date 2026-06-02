import { Images, Inbox } from "lucide-react";
import { EmptyState } from "@/components/shared/EmptyState";
import type { TrackerEntry } from "@/components/shared/types";
import { EntryItem } from "./EntryItem";
import { cn } from "@/lib/utils";
import type { WorkflowRunProjection } from "../../../domain/workflow-runtime/types.js";
import { tracePrefix } from "../../../domain/queue-trace-id.js";

/**
 * Fallback title for daemon / dashboard batch cards when no projection title is
 * supplied (the projection's `batchGroupTitle` is the primary path).
 *
 * A batch is titled **only by a PDF filename**. Person / arbitrary batches have
 * NO title — the `{done}/{total}` count badge + the member-name preview already
 * identify the bag of people. A `titleOverride` is honored only when it is
 * itself a PDF filename (an inherited delegated *file*-batch label); a random /
 * person name is never used as a title.
 */
export function resolveDaemonBatchQueueTitle(
  _workflowLabel: string,
  members: TrackerEntry[],
  _batchParentRunId: string,
  titleOverride?: string,
): string {
  const pdfName = members.map((m) => m.data?.pdfOriginalName).find((v) => v != null && v !== "");
  if (pdfName) return pdfName;
  if (titleOverride && /\.pdf$/i.test(titleOverride)) return titleOverride;
  return "";
}

/**
 * Fixed header for **batch queue mode**: scoped list of member rows (delegated
 * runs, future daemon batches, etc.) without mixing them into the main queue.
 * Renders above the scrollable {@link BatchQueueMemberList}.
 */
export function BatchQueueToolbar({
  batchAnchor,
  projection,
  titleOverride,
  anchorKind = "prep",
  memberCount,
  batchPreviewActive,
  onBack,
  onOpenPrepReview,
  onOpenBatchPreview,
}: {
  batchAnchor: TrackerEntry;
  projection?: WorkflowRunProjection;
  /** When set, replaces the default title from tracker data (for non-OCR batches). */
  titleOverride?: string;
  /** Prep batches use an "Approved …" subtitle; daemon/dashboard batches use "Started …". */
  anchorKind?: "prep" | "daemon";
  /** Current member count, shown in the batch screenshot preview affordance. */
  memberCount?: number;
  /** Whether the right pane is showing the batch screenshot preview. */
  batchPreviewActive?: boolean;
  onBack: () => void;
  /** OCR / prep batches only — omit when the batch has no prep review surface. */
  onOpenPrepReview?: () => void;
  /** Opens the right-pane batch screenshot preview. */
  onOpenBatchPreview?: () => void;
}) {
  const title =
    projection?.title ??
    titleOverride ??
    batchAnchor.data?.pdfOriginalName ??
    "Batch";
  const runId = batchAnchor.runId ?? batchAnchor.id;
  const time = formatBatchToolbarTime(batchAnchor.timestamp);
  const startedLabel = anchorKind === "prep" ? "Approved" : "Started";
  // Operation id for the batch header — the shared trace PREFIX (`ou-090553`)
  // of the batch's trace id, so the header reads as part of the same scheme as
  // its members (which compose `<prefix>-<ownRunId4>`). Falls back to the legacy
  // `batch#<run4>` when no trace id is stamped (legacy/unstamped rows).
  const anchorTraceId = batchAnchor.data?.__traceId;
  const operationId = anchorTraceId ? tracePrefix(anchorTraceId) : `batch#${runId.slice(-4)}`;
  return (
    <div className="h-[69.5px] flex flex-col justify-center px-3 min-[1440px]:px-4 border-b border-border bg-card/60 shrink-0 gap-1">
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to queue"
          title="Back to queue"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-secondary/40 text-foreground hover:bg-secondary/70 shrink-0"
        >
          ←
        </button>
        <span className="text-muted-foreground/60">/</span>
        <span className="font-semibold text-[13px] text-foreground truncate min-w-0 flex-1">
          {title}
        </span>
        {onOpenBatchPreview ? (
          <button
            type="button"
            onClick={onOpenBatchPreview}
            aria-label={
              typeof memberCount === "number"
                ? `Show batch screenshot preview for ${memberCount} rows`
                : "Show batch screenshot preview"
            }
            aria-pressed={batchPreviewActive}
            title="Show batch screenshot preview"
            className={cn(
              "inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card",
              batchPreviewActive
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
            )}
          >
            <Images className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <div className="text-[10px] font-mono text-muted-foreground pl-1 flex items-center gap-1.5 flex-wrap">
        <span>
          {startedLabel} {time} · {operationId}
        </span>
        {onOpenPrepReview ? (
          <>
            <span className="text-muted-foreground/50">·</span>
            <button
              type="button"
              onClick={onOpenPrepReview}
              className="text-primary hover:text-primary/80 underline-offset-2 hover:underline transition-colors"
            >
              Open prep review
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Minimal tracker-shaped row for batch-queue toolbar when the batch "parent"
 * is a dashboard grouping id (no OCR prep row on disk).
 */
export function buildSyntheticBatchQueueAnchor(
  batchParentRunId: string,
  members: TrackerEntry[],
  workflowLabel?: string,
  /** Kernel workflow id when `members` is empty (batch view opened before SSE rows arrive). */
  workflowName?: string,
): TrackerEntry {
  const sorted =
    members.length > 0
      ? [...members].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      : [];
  const first = sorted[0];
  const wf = first?.workflow ?? workflowName ?? "workflow";
  const label = workflowLabel ?? wf;
  const ts = first?.timestamp ?? new Date().toISOString();
  const title = resolveDaemonBatchQueueTitle(label, members, batchParentRunId);
  return {
    workflow: wf,
    id: batchParentRunId,
    runId: batchParentRunId,
    timestamp: ts,
    status: "pending",
    data: {
      pdfOriginalName: members.length > 0 ? `${title} (${members.length})` : title,
    },
  };
}

function formatBatchToolbarTime(ts: string): string {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts.slice(11, 16);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return ts.slice(11, 16);
  }
}

/**
 * Scrollable list of **batch member** rows. Each row is a normal {@link EntryItem}.
 * Do not render {@link DelegationRow} / {@link DaemonBatchRow} here — batch mode is
 * one level deep; nested batch navigation is blocked in `App` (`handleEnterBatchQueue`)
 * until the operator uses Back to return to the main queue.
 */
export function BatchQueueMemberList({
  members,
  projections,
  selectedId,
  onSelect,
  displayNames,
  date,
  onDelete,
  emptyDescription = "Members will appear here as the workflow processes them",
}: {
  members: TrackerEntry[];
  projections?: WorkflowRunProjection[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  displayNames?: Map<string, string>;
  date?: string;
  onDelete?: (id: string) => void;
  /** Shown under “No members yet” when the batch is empty. */
  emptyDescription?: string;
}) {
  if (members.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No members yet"
        description={emptyDescription}
      />
    );
  }
  return (
    <>
      {members.map((entry) => {
        const projection = projections?.find(
          (candidate) => candidate.runId === (entry.runId ?? entry.id),
        );
        return (
        <EntryItem
          key={entry.id}
          entry={entry}
          projection={projection}
          displayNames={displayNames}
          selected={selectedId === entry.id}
          onSelect={onSelect}
          date={date}
          onDelete={onDelete}
        />
        );
      })}
    </>
  );
}
