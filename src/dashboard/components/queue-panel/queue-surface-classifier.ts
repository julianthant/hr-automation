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
    case "preview":
      return {
        kind: "preview",
        parentRunId: surface.parentRunId,
        parent: toDashboardEntry(surface.parent),
        members: surface.members.map(toDashboardEntry),
        approvalState: surface.approvalState,
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
    case "operation":
      return {
        kind: "operation",
        parentRunId: surface.parentRunId,
        parent: toDashboardEntry(surface.parent),
        members: surface.members.map(toDashboardEntry),
        ...(surface.ocr ? { ocr: surface.ocr } : {}),
        titleOverride: surface.titleOverride,
      };
  }
}

export type QueueGroupSurfaceKind = "preview" | "batch" | "operation";

export interface OperationOcrLink {
  runId: string;
  sessionId?: string;
  status: string;
  step?: string;
}

export interface PreviewSurface {
  kind: "preview";
  parentRunId: string;
  parent: TrackerEntry;
  members: TrackerEntry[];
  approvalState: "awaiting-approval" | "approved" | "discarded";
  titleOverride?: string;
}

export interface BatchSurface {
  kind: "batch";
  parentRunId: string;
  parent?: TrackerEntry;
  members: TrackerEntry[];
  titleOverride?: string;
}

export interface OperationSurface {
  kind: "operation";
  parentRunId: string;
  parent: TrackerEntry;
  members: TrackerEntry[];
  ocr?: OperationOcrLink;
  titleOverride?: string;
}

export type QueueGroupSurface = PreviewSurface | BatchSurface | OperationSurface;

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
  /**
   * Flat single-row projection of a preview surface's parent. A preview with
   * no delegated members (the OCR review row awaiting approval) renders as a
   * flat {@link EntryItem} — not the member-summary `DelegationRow` — so it
   * needs the parent's own status-gated row actions + kind title/subtitle,
   * exactly like a `single` row. Absent for batch surfaces and for previews
   * that have fanned out to members.
   */
  parentProjection?: WorkflowRunProjection;
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
    ...(surface.kind === "preview"
      ? { parentProjection: buildWorkflowRunProjection(toJsonlEntry(surface.parent), context) }
      : {}),
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
