import type { TrackerEntry } from "@/components/shared/types";
import {
  buildTrackerQueueSurfaces,
  countTopLevelQueueSurfaceRows,
} from "../../../tracker/queue-surfaces.js";
import type { TrackerEntry as TrackerEntryJsonl } from "../../../tracker/jsonl.js";

export type QueueGroupSurfaceKind = "approval-delegation" | "passive-delegation" | "batch";

export interface ApprovalDelegationSurface {
  kind: "approval-delegation";
  parentRunId: string;
  parent: TrackerEntry;
  members: TrackerEntry[];
  approvalState: "awaiting-approval" | "approved" | "discarded";
  titleOverride?: string;
}

export interface PassiveDelegationSurface {
  kind: "passive-delegation";
  parentRunId: string;
  members: TrackerEntry[];
  titleOverride?: string;
}

export interface BatchSurface {
  kind: "batch";
  parentRunId: string;
  members: TrackerEntry[];
  titleOverride?: string;
}

export type QueueGroupSurface =
  | ApprovalDelegationSurface
  | PassiveDelegationSurface
  | BatchSurface;

export interface BuildQueueSurfacesInput {
  entries: TrackerEntry[];
  delegationSourceEntries: TrackerEntry[];
  workflow: string;
  workflowLabel: string;
}

export interface QueueSurfaces {
  groupRows: QueueGroupSurface[];
  flatEntries: TrackerEntry[];
  membersByParentRunId: Map<string, TrackerEntry[]>;
  approvalParentRunIds: Set<string>;
}

export function buildQueueSurfaces(input: BuildQueueSurfacesInput): QueueSurfaces {
  const core = buildTrackerQueueSurfaces({
    entries: input.entries as TrackerEntryJsonl[],
    delegationSourceEntries: input.delegationSourceEntries as TrackerEntryJsonl[],
  });
  return {
    groupRows: core.groupRows as QueueGroupSurface[],
    flatEntries: core.flatEntries as TrackerEntry[],
    membersByParentRunId: core.membersByParentRunId as Map<string, TrackerEntry[]>,
    approvalParentRunIds: core.approvalParentRunIds,
  };
}

/**
 * Top-level rows rendered in the queue (group cards + flat rows). Matches
 * WorkflowRail / cross-workflow wfCounts — not {@link collapseMergedPrimariesForQueueStrip}.
 */
export function countQueuePanelTopLevelRows(input: BuildQueueSurfacesInput): number {
  return countTopLevelQueueSurfaceRows({
    entries: input.entries as TrackerEntryJsonl[],
    delegationSourceEntries: input.delegationSourceEntries as TrackerEntryJsonl[],
  });
}
