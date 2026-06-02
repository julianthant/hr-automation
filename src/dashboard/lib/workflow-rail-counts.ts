export interface BuildWorkflowRailEntryCountsInput {
  wfCounts: Record<string, number>;
  activeWorkflow: string;
  activeEntriesKey: string;
  activeQueuePanelTopLevelCount: number;
}

/**
 * WorkflowRail badges are backend-authoritative cross-workflow aggregates.
 * The selected queue panel can include scoped or review-only rows, so it must
 * not override the rail count for the active workflow.
 */
export function buildWorkflowRailEntryCounts(
  input: BuildWorkflowRailEntryCountsInput,
): Record<string, number> {
  void input.activeWorkflow;
  void input.activeEntriesKey;
  void input.activeQueuePanelTopLevelCount;
  return { ...input.wfCounts };
}
