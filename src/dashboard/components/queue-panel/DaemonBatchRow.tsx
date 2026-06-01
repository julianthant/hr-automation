import { useMemo } from "react";
import type { TrackerEntry } from "@/components/shared/types";
import { resolveDaemonBatchQueueTitle } from "./batch-queue-view";
import { GroupRowBase } from "./group-row-base";
import { BatchFooterActions } from "./BatchFooterActions";
import type { WorkflowRunProjection } from "../../../domain/workflow-runtime/types.js";

export interface DaemonBatchRowProps {
  workflow: string;
  /** Tracker date — required for bulk delete API. */
  date?: string;
  /** Shared `parentRunId` / dashboard batch id for all members. */
  batchParentRunId: string;
  /** Workflow label for display (kernel registry). */
  workflowLabel: string;
  /** Optional inherited display title for delegated batches. */
  titleOverride?: string;
  projection?: WorkflowRunProjection;
  memberEntries: TrackerEntry[];
  /**
   * The batch anchor (parent) row. Used as the footer fallback when the batch
   * has no members yet (a `batch` anchor before it fans out — e.g. the
   * oath-signature PDF row during OCR approval), so the uniform footer keeps
   * its time / elapsed / retry+delete instead of collapsing to a bare `#run`.
   */
  anchorEntry?: TrackerEntry;
  isBatchQueueFocused: boolean;
  onEnterBatchQueue: (batchParentRunId: string) => void;
  /**
   * When false, the row is display-only (no drill-in). Use inside surfaces
   * where nested batch navigation is forbidden.
   */
  batchDrillInEnabled?: boolean;
  /** Called after bulk-delete removes rows so the parent can clear selection. */
  onDeletedIds?: (ids: string[]) => void;
}

/**
 * Summary card for a **daemon / dashboard batch**: multiple queue items that
 * share the same `parentRunId` from one multi-enqueue or batch-context run.
 */
export function DaemonBatchRow({
  workflow,
  date,
  batchParentRunId,
  workflowLabel,
  titleOverride,
  projection,
  memberEntries,
  anchorEntry,
  isBatchQueueFocused,
  onEnterBatchQueue,
  batchDrillInEnabled = true,
  onDeletedIds,
}: DaemonBatchRowProps) {
  // Footer source: members once they exist, else the batch anchor (so a
  // 0-member pre-fan-out batch still shows time / elapsed / retry+delete).
  // `members` stays as-is for the count badge + progress bar (0/0).
  const footerEntries = useMemo(
    () => (memberEntries.length > 0 ? memberEntries : anchorEntry ? [anchorEntry] : memberEntries),
    [memberEntries, anchorEntry],
  );
  const firstTimestamp = useMemo(
    () =>
      [...footerEntries].sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0]?.timestamp,
    [footerEntries],
  );
  const title = useMemo(
    () => resolveDaemonBatchQueueTitle(workflowLabel, memberEntries, batchParentRunId, titleOverride),
    [workflowLabel, memberEntries, batchParentRunId, titleOverride],
  );

  const footerActions = (
    <BatchFooterActions
      workflow={workflow}
      date={date}
      batchParentRunId={batchParentRunId}
      memberEntries={footerEntries}
      projection={projection}
      onDeletedIds={onDeletedIds}
    />
  );

  return (
    <GroupRowBase
      variant="batch"
      title={projection?.title ?? title}
      parentRunId={batchParentRunId}
      members={memberEntries}
      countTone="neutral"
      footerSecondaryId={projection?.subtitle}
      firstTimestamp={firstTimestamp}
      elapsedEntries={footerEntries}
      isFocused={isBatchQueueFocused}
      drillInEnabled={batchDrillInEnabled}
      onEnter={onEnterBatchQueue}
      footerActions={footerActions}
    />
  );
}
