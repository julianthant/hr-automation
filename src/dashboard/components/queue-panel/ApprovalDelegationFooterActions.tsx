import type { TrackerEntry } from "@/components/shared/types";
import { RetryButton } from "@/components/shared/RetryButton";
import { DeleteButton } from "@/components/shared/DeleteButton";
import { BatchFooterActions } from "./BatchFooterActions";
import { isDelegatedOcrAwaitingApprovalEntry, isOcrAwaitingApprovalEntry } from "../../../tracker/dashboard/prep-rows.js";
import type { WorkflowRunProjection } from "../../../domain/workflow-runtime/types.js";

export interface ApprovalDelegationFooterActionsProps {
  parent: TrackerEntry;
  delegatedEntries: TrackerEntry[];
  projection?: WorkflowRunProjection;
  batchParentRunId: string;
  date?: string;
  onDelete?: (id: string) => void;
}

function needsReview(entry: TrackerEntry): boolean {
  if (isDelegatedOcrAwaitingApprovalEntry(entry)) return true;
  if (isOcrAwaitingApprovalEntry(entry)) return true;
  return false;
}

function shouldShowRetryDelete(entry: TrackerEntry): boolean {
  const isCancelled = entry.status === "failed" && entry.step === "cancelled";
  const isFailed = entry.status === "failed" && !isCancelled;
  return isFailed || isCancelled || needsReview(entry);
}

function shouldShowDeleteOnly(entry: TrackerEntry): boolean {
  return entry.status === "done" && !needsReview(entry);
}

/**
 * Footer controls for preview group cards. Single-signer (and
 * prep-only) cards reuse the same retry/delete affordances as {@link EntryItem};
 * multi-member cards keep batch-scoped bulk actions and delete the prep parent
 * together with its delegated children.
 */
export function ApprovalDelegationFooterActions({
  parent,
  delegatedEntries,
  projection,
  batchParentRunId,
  date,
  onDelete,
}: ApprovalDelegationFooterActionsProps) {
  const actions = projection?.actions;

  if (delegatedEntries.length <= 1) {
    const target = delegatedEntries[0] ?? parent;
    const showRetryDelete = shouldShowRetryDelete(target);
    const showDeleteOnly = shouldShowDeleteOnly(target);

    if (!showRetryDelete && !showDeleteOnly) return null;

    return (
      <>
        {showRetryDelete && (
          <RetryButton
            workflow={target.workflow}
            id={target.id}
            runId={target.runId}
            date={date}
            actions={actions}
          />
        )}
        {(showRetryDelete || showDeleteOnly) && onDelete && date ? (
          <DeleteButton
            workflow={target.workflow}
            id={target.id}
            date={date}
            runId={target.runId}
            actions={actions}
            onDeleted={onDelete}
          />
        ) : null}
      </>
    );
  }

  return (
    <BatchFooterActions
      workflow={parent.workflow}
      date={date}
      batchParentRunId={batchParentRunId}
      memberEntries={delegatedEntries}
      retryMemberEntries={delegatedEntries}
      deleteMemberEntries={[parent, ...delegatedEntries]}
      projection={projection}
      onDeletedIds={(ids) => {
        if (ids.includes(parent.id)) onDelete?.(parent.id);
      }}
    />
  );
}
