import type { TrackerEntry } from "@/components/shared/types";
import { resolveEntryName } from "@/components/shared/entry-display";
import {
  buildProjectionFromQueueSurface,
  buildWorkflowRunProjection,
  type WorkflowProjectionContext,
} from "../../../domain/workflow-runtime/projection.js";
import type { WorkflowRunProjection } from "../../../domain/workflow-runtime/types.js";
import {
  buildTrackerQueueSurfaces,
  countTopLevelQueueSurfaceRows,
  type TrackerQueueGroupSurface,
} from "../../../tracker/queue-surfaces.js";
import type { TrackerEntry as TrackerEntryJsonl } from "../../../tracker/jsonl.js";
import type { WorkflowRuntimePolicyLookup } from "../../../domain/workflow-runtime/registry.js";

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
        ...(surface.parent ? { parent: toDashboardEntry(surface.parent) } : {}),
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
  parent?: TrackerEntry;
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
  displayNames?: Map<string, string>;
  runtimePolicies?: WorkflowRuntimePolicyLookup;
}

export interface QueueSurfaces {
  groupRows: QueueGroupSurface[];
  flatEntries: TrackerEntry[];
  membersByParentRunId: Map<string, TrackerEntry[]>;
  approvalParentRunIds: Set<string>;
}

export interface QueueGroupProjectionRow {
  surface: QueueGroupSurface;
  projection: WorkflowRunProjection;
}

export interface QueueEntryProjectionRow {
  entry: TrackerEntry;
  projection: WorkflowRunProjection;
}

export interface QueueProjectionRows {
  surfaces: QueueSurfaces;
  groupRows: QueueGroupProjectionRow[];
  flatEntries: QueueEntryProjectionRow[];
  projections: WorkflowRunProjection[];
}

function projectionContext(input: BuildQueueSurfacesInput): WorkflowProjectionContext {
  return {
    workflowLabels: new Map([[input.workflow, input.workflowLabel]]),
    resolveEntryTitle: input.displayNames
      ? (entry) => resolveEntryName(toDashboardEntry(entry), input.displayNames)
      : undefined,
    runtimePolicies: input.runtimePolicies,
  };
}

export function buildQueueSurfaces(input: BuildQueueSurfacesInput): QueueSurfaces {
  const core = buildTrackerQueueSurfaces({
    entries: input.entries.map(toJsonlEntry),
    delegationSourceEntries: input.delegationSourceEntries.map(toJsonlEntry),
    runtimePolicies: input.runtimePolicies,
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

export function buildQueueProjectionRows(input: BuildQueueSurfacesInput): QueueProjectionRows {
  const surfaces = buildQueueSurfaces(input);
  const context = projectionContext(input);
  const groupRows = surfaces.groupRows.map((surface) => ({
    surface,
    projection: buildProjectionFromQueueSurface(
      surface as unknown as TrackerQueueGroupSurface,
      context,
    ),
  }));
  const flatEntries = surfaces.flatEntries.map((entry) => ({
    entry,
    projection: buildWorkflowRunProjection(toJsonlEntry(entry), context),
  }));
  return {
    surfaces,
    groupRows,
    flatEntries,
    projections: [
      ...groupRows.map((row) => row.projection),
      ...flatEntries.map((row) => row.projection),
    ],
  };
}

export function buildQueueProjections(input: BuildQueueSurfacesInput): WorkflowRunProjection[] {
  return buildQueueProjectionRows(input).projections;
}

/**
 * Top-level rows rendered in the queue (group cards + flat rows). Matches
 * WorkflowRail / cross-workflow wfCounts — not {@link collapseMergedPrimariesForQueueStrip}.
 */
export function countQueuePanelTopLevelRows(input: BuildQueueSurfacesInput): number {
  return countTopLevelQueueSurfaceRows({
    entries: input.entries.map(toJsonlEntry),
    delegationSourceEntries: input.delegationSourceEntries.map(toJsonlEntry),
    runtimePolicies: input.runtimePolicies,
  });
}
