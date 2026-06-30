import { ArrowLeft, ClipboardList, Images, Inbox } from "lucide-react";
import { EmptyState } from "@/components/shared/EmptyState";
import type { TrackerEntry } from "@/components/shared/types";
import { EntryItem } from "./EntryItem";
import { cn } from "@/lib/utils";
import type { WorkflowRunProjection } from "../../../domain/workflow-runtime/types.js";

/**
 * Fallback title for daemon / dashboard batch cards when no projection title is
 * supplied (the projection's `operationGroupTitle` is the primary path).
 *
 * A batch is titled **only by a PDF filename**. Person / arbitrary batches have
 * NO title — the `{done}/{total}` count badge + the member-name preview already
 * identify the bag of people. A `titleOverride` is honored only when it is
 * itself a PDF filename (an inherited delegated *file*-batch label); a random /
 * person name is never used as a title.
 */
export function resolveDaemonOperationQueueTitle(
  _workflowLabel: string,
  members: TrackerEntry[],
  _operationParentRunId: string,
  titleOverride?: string,
): string {
  const pdfName = members.map((m) => m.data?.pdfOriginalName).find((v) => v != null && v !== "");
  if (pdfName) return pdfName;
  if (titleOverride && /\.pdf$/i.test(titleOverride)) return titleOverride;
  return "";
}

/**
 * Batch-queue mode chrome lives in the **single consolidated toolbar** (no
 * separate header band): the Back affordance sits before the sort dropdown and
 * the screenshot-preview / prep-review affordances sit after the bulk actions
 * (after the trash). These small buttons are rendered into `QueueSortToolbar`'s
 * `leading` / `actions` slots by `QueuePanel`.
 */
export function OperationQueueBackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      aria-label="Back to queue"
      title="Back to queue"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary/40 text-foreground transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
    </button>
  );
}

/** Toggle the right-pane batch screenshot preview. Placed after the trash. */
export function OperationQueuePreviewButton({
  active,
  memberCount,
  onOpen,
}: {
  active?: boolean;
  memberCount?: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={
        typeof memberCount === "number"
          ? `Show batch screenshot preview for ${memberCount} rows`
          : "Show batch screenshot preview"
      }
      aria-pressed={active}
      title="Show batch screenshot preview"
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
      )}
    >
      <Images className="h-4 w-4" aria-hidden />
    </button>
  );
}

/** Jump to the OCR/prep review for a prep batch. Shown only for prep anchors. */
export function OperationQueuePrepReviewButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open prep review"
      title="Open prep review"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-info/40 bg-info/10 text-info transition-colors hover:border-info/60 hover:bg-info/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-1 focus-visible:ring-offset-card"
    >
      <ClipboardList className="h-4 w-4" aria-hidden />
    </button>
  );
}

/**
 * Scrollable list of **batch member** rows. Each row is a normal {@link EntryItem}.
 * Do not render {@link DelegationRow} or operation rows here — operation drill-in mode is
 * one level deep; nested operation-drill-in navigation is blocked in `App` (`handleEnterOperationQueue`)
 * until the operator uses Back to return to the main queue.
 */
export function OperationQueueMemberList({
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
