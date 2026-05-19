import type { TrackerEntry } from "@/components/shared/types";
import {
  buildTrackerQueueSurfaces,
  countTopLevelQueueSurfaceRows,
  type TrackerQueueGroupSurface,
} from "../../../tracker/queue-surfaces.js";
import type { TrackerEntry as TrackerEntryJsonl } from "../../../tracker/jsonl.js";

/**
 * Identity cast. `TrackerEntry` (dashboard) is a structural superset of
 * `TrackerEntryJsonl`; passing the original ref through preserves SSE
 * enrichments (_hash, firstLogTs, lastLogTs, lastLogMessage, stepDurations,
 * etc.) so EntryItem's memo and queue sort keep working.
 */
function toJsonlEntry(entry: TrackerEntry): TrackerEntryJsonl {
  return entry as unknown as TrackerEntryJsonl;
}

/**
 * Identity cast in reverse. Entries that flow through buildTrackerQueueSurfaces
 * originated from useEntries — they still carry dashboard enrichments at
 * runtime even though the JSONL type doesn't surface them.
 */
function toDashboardEntry(entry: TrackerEntryJsonl): TrackerEntry {
  return entry as unknown as TrackerEntry;
}

function mapGroupSurface(surface: TrackerQueueGroupSurface): QueueGroupSurface {
  switch (surface.kind) {
    case "approval-delegation":
      return {
        kind: "approval-delegation",
        parentRunId: surface.parentRunId,
        parent: toDashboardEntry(surface.parent),
        members: surface.members.map(toDashboardEntry),
        approvalState: surface.approvalState,
        titleOverride: surface.titleOverride,
      };
    case "passive-delegation":
      return {
        kind: "passive-delegation",
        parentRunId: surface.parentRunId,
        members: surface.members.map(toDashboardEntry),
        titleOverride: surface.titleOverride,
      };
    case "batch":
      return {
        kind: "batch",
        parentRunId: surface.parentRunId,
        members: surface.members.map(toDashboardEntry),
        titleOverride: surface.titleOverride,
      };
  }
}

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
    entries: input.entries.map(toJsonlEntry),
    delegationSourceEntries: input.delegationSourceEntries.map(toJsonlEntry),
  });
  return {
    groupRows: core.groupRows.map(mapGroupSurface),
    flatEntries: core.flatEntries.map(toDashboardEntry),
    membersByParentRunId: new Map(
      [...core.membersByParentRunId.entries()].map(([parentRunId, members]) => [
        parentRunId,
        members.map(toDashboardEntry),
      ]),
    ),
    approvalParentRunIds: core.approvalParentRunIds,
  };
}

/**
 * Top-level rows rendered in the queue (group cards + flat rows). Matches
 * WorkflowRail / cross-workflow wfCounts — not {@link collapseMergedPrimariesForQueueStrip}.
 */
export function countQueuePanelTopLevelRows(input: BuildQueueSurfacesInput): number {
  return countTopLevelQueueSurfaceRows({
    entries: input.entries.map(toJsonlEntry),
    delegationSourceEntries: input.delegationSourceEntries.map(toJsonlEntry),
  });
}
