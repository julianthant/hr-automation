import type { TrackerEntry } from "@/components/shared/types";
import { RetryButton } from "@/components/shared/RetryButton";
import { DeleteButton } from "@/components/shared/DeleteButton";
import { BatchFooterActions } from "./BatchFooterActions";
import type { WorkflowRunProjection } from "../../../domain/workflow-runtime/types.js";

export interface ApprovalDelegationFooterActionsProps {
  parent: TrackerEntry;
  delegatedEntries: TrackerEntry[];
  projection?: WorkflowRunProjection;
  batchParentRunId: string;
  date?: string;
  onDelete?: (id: string) => void;
}

/**
 * Footer controls for preview group cards. Single-signer (and prep-only) cards
 * reuse the same retry/delete affordances as {@link EntryItem}; multi-member
 * cards keep batch-scoped bulk actions and delete the prep parent together with
 * its delegated children.
 *
 * Retry + delete render uniformly for every single-member / preview state — they
 * self-hide only when the kernel's action descriptor disables them (see
 * {@link RetryButton} / {@link DeleteButton}), never on client-side status. This
 * keeps these footers identical to every other queue footer.
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

    return (
      <>
        <RetryButton
          workflow={target.workflow}
          id={target.id}
          runId={target.runId}
          date={date}
          actions={actions}
        />
        {onDelete && date ? (
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
