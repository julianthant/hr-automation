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
  isBatchQueueFocused,
  onEnterBatchQueue,
  batchDrillInEnabled = true,
  onDeletedIds,
}: DaemonBatchRowProps) {
  const firstTimestamp = useMemo(
    () =>
      [...memberEntries].sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0]?.timestamp,
    [memberEntries],
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
      memberEntries={memberEntries}
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
      isFocused={isBatchQueueFocused}
      drillInEnabled={batchDrillInEnabled}
      onEnter={onEnterBatchQueue}
      footerActions={footerActions}
    />
  );
}
