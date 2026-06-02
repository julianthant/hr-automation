import { resolveRowArchetype, type RowArchetype } from "../domain/row-archetype.js";
import {
  getWorkflowRuntimePolicy,
  type WorkflowRuntimePolicyLookup,
} from "../domain/workflow-runtime/registry.js";
import type { TrackerEntry } from "./jsonl.js";

export interface TrackerRowClassification {
  shape: RowArchetype;
  scope: "root" | "delegated";
}

export function classifyTrackerRow(entry: TrackerEntry): TrackerRowClassification {
  return {
    shape: resolveRowArchetype(entry),
    scope: entry.parentRunId ? "delegated" : "root",
  };
}

function isBatchAnchor(entry: TrackerEntry): boolean {
  return classifyTrackerRow(entry).shape === "batch";
}

function isPreviewAnchor(entry: TrackerEntry): boolean {
  const classification = classifyTrackerRow(entry);
  if (classification.shape === "preview") return true;
  // Compatibility for older OCR JSONL rows written before `preview` became a
  // first-class archetype. Forward writes should stamp `preview`.
  return classification.shape === "batch" && entry.workflow === "ocr" && entry.data?.mode === "prepare";
}

function entryKey(entry: Pick<TrackerEntry, "workflow" | "id" | "runId">): string {
  return `${entry.workflow}\0${entry.id}\0${entry.runId ?? ""}`;
}

function isDiscardedPreviewRow(e: TrackerEntry): boolean {
  if (!isPreviewAnchor(e)) return false;
  return e.status === "failed" && e.step === "discarded";
}

function isApprovedPreviewRow(e: TrackerEntry): boolean {
  if (!isPreviewAnchor(e)) return false;
  // New approval contract (2026-05-25): OCR rows only ever reach
  // `status="done"` after the operator approves. The kernel-path handler
  // suspends at `awaiting-approval` and the orchestrator emits `running`
  // until approve fires — so any OCR `done` row is approved, whether or
  // not the step was stamped (approve route writes `step=approved`; the
  // kernel's auto-emitted terminal `done` carries no step).
  if (e.status === "done" && (e.step === "approved" || e.workflow === "ocr")) return true;
  // Non-OCR prep rows (today none) keep the explicit step gate.
  return e.status === "done" && e.step === "approved";
}

function isVisibleBatchAnchor(e: TrackerEntry): boolean {
  return isBatchAnchor(e) && !isPreviewAnchor(e);
}

function isVisiblePreviewAnchor(e: TrackerEntry): boolean {
  return isPreviewAnchor(e) && !isDiscardedPreviewRow(e);
}

function runIdFor(entry: Pick<TrackerEntry, "id" | "runId">): string {
  return entry.runId ?? entry.id;
}

/**
 * True when the entry's workflow opts into batching its delegated rows even at
 * a count of one (`delegation.alwaysBatchDelegatedMembers`). Keeps a single
 * fanned-out signer / person-lookup result rendering as a one-member batch
 * instead of collapsing to a standalone single row.
 */
function forcesBatchWhenDelegated(
  entry: TrackerEntry,
  runtimePolicies?: WorkflowRuntimePolicyLookup,
): boolean {
  return (
    getWorkflowRuntimePolicy(entry.workflow, runtimePolicies).delegation
      ?.alwaysBatchDelegatedMembers === true
  );
}

function rootPersistingParentRunIds(
  entries: TrackerEntry[],
  runtimePolicies?: WorkflowRuntimePolicyLookup,
): Set<string> {
  const runIds = new Set<string>();
  for (const entry of entries) {
    if (!isVisibleBatchAnchor(entry)) continue;
    const policy = getWorkflowRuntimePolicy(entry.workflow, runtimePolicies);
    if (policy.delegation?.rootRowPersistsThroughChildren) {
      runIds.add(runIdFor(entry));
    }
  }
  return runIds;
}

function buildMembersByParentRunId(
  entries: TrackerEntry[],
  rootPersistingRunIds: Set<string>,
): Map<string, TrackerEntry[]> {
  const map = new Map<string, TrackerEntry[]>();
  for (const entry of entries) {
    if (!entry.parentRunId) continue;
    if ((isVisibleBatchAnchor(entry) || isVisiblePreviewAnchor(entry)) && !rootPersistingRunIds.has(entry.parentRunId)) {
      continue; // grouped rows are anchors, not members
    }
    const list = map.get(entry.parentRunId) ?? [];
    list.push(entry);
    map.set(entry.parentRunId, list);
  }
  return map;
}

function uniqueFlatEntries(entries: TrackerEntry[]): TrackerEntry[] {
  const byKey = new Map<string, TrackerEntry>();
  for (const entry of entries) {
    byKey.set(entryKey(entry), entry);
  }
  return [...byKey.values()];
}

export interface TrackerPreviewSurface {
  kind: "preview";
  parentRunId: string;
  parent: TrackerEntry;
  members: TrackerEntry[];
  approvalState: "awaiting-approval" | "approved" | "discarded";
  titleOverride?: string;
}

export interface TrackerBatchSurface {
  kind: "batch";
  parentRunId: string;
  parent?: TrackerEntry;
  members: TrackerEntry[];
  titleOverride?: string;
}

export type TrackerQueueGroupSurface = TrackerPreviewSurface | TrackerBatchSurface;

export interface TrackerQueueSurfaces {
  groupRows: TrackerQueueGroupSurface[];
  flatEntries: TrackerEntry[];
  membersByParentRunId: Map<string, TrackerEntry[]>;
  approvalParentRunIds: Set<string>;
}

export interface BuildTrackerQueueSurfacesInput {
  entries: TrackerEntry[];
  delegationSourceEntries: TrackerEntry[];
  runtimePolicies?: WorkflowRuntimePolicyLookup;
}

function titleOverrideForAnchor(entry: TrackerEntry): string | undefined {
  const data = entry.data ?? {};
  for (const value of [
    data.pdfOriginalName,
    data.__queueRootTitle,
    data.__queueTitle,
    data.parentSubject,
    data.__name,
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Canonical queue **surface** model: one group card + zero or more flat rows.
 * Shared by dashboard `buildQueueSurfaces` and sidebar / wfCounts aggregation
 * so digits never double-count children that render inside a card.
 */
export function buildTrackerQueueSurfaces(input: BuildTrackerQueueSurfacesInput): TrackerQueueSurfaces {
  const visibleEntries = input.entries.filter((entry) => !isDiscardedPreviewRow(entry));
  const visibleSources = input.delegationSourceEntries.filter(
    (entry) => !isDiscardedPreviewRow(entry),
  );
  const rootPersistingRunIds = rootPersistingParentRunIds(visibleSources, input.runtimePolicies);
  const membersByParentRunId = buildMembersByParentRunId(visibleSources, rootPersistingRunIds);
  const batchAnchors = visibleEntries.filter(isVisibleBatchAnchor);
  const previewAnchors = visibleEntries.filter(isVisiblePreviewAnchor);
  const batchAnchorRunIds = new Set(batchAnchors.map((entry) => entry.runId ?? entry.id));
  const previewAnchorRunIds = new Set(previewAnchors.map((entry) => entry.runId ?? entry.id));
  const anchoredParentRunIds = new Set([...batchAnchorRunIds, ...previewAnchorRunIds]);
  const approvalParentRunIds = new Set([...previewAnchorRunIds]);
  const singleChildEntries: TrackerEntry[] = [];

  const groupRows: TrackerQueueGroupSurface[] = [];

  for (const parent of previewAnchors) {
    const parentRunId = parent.runId ?? parent.id;
    const members = membersByParentRunId.get(parentRunId) ?? [];
    groupRows.push({
      kind: "preview",
      parentRunId,
      parent,
      members,
      approvalState: isApprovedPreviewRow(parent) ? "approved" : "awaiting-approval",
    });
  }

  for (const parent of batchAnchors) {
    const parentRunId = parent.runId ?? parent.id;
    const members = membersByParentRunId.get(parentRunId) ?? [];
    groupRows.push({
      kind: "batch",
      parentRunId,
      parent,
      members,
      titleOverride: titleOverrideForAnchor(parent),
    });
  }

  for (const [parentRunId, members] of membersByParentRunId) {
    if (anchoredParentRunIds.has(parentRunId)) continue;
    // A lone delegated child normally renders as a flat single row — unless its
    // workflow opts into `alwaysBatchDelegatedMembers` (oath-signature,
    // person-lookup), where even one member stays a one-member batch surface.
    if (members.length === 1 && !forcesBatchWhenDelegated(members[0]!, input.runtimePolicies)) {
      singleChildEntries.push(members[0]!);
      continue;
    }
    groupRows.push({
      kind: "batch",
      parentRunId,
      members,
    });
  }

  const groupedParentRunIds = new Set(groupRows.map((surface) => surface.parentRunId));
  const visibleFlatEntries = visibleEntries.filter((entry) => {
    if (isVisibleBatchAnchor(entry) || isVisiblePreviewAnchor(entry)) return false;
    if (entry.parentRunId && groupedParentRunIds.has(entry.parentRunId)) return false;
    if (entry.parentRunId && membersByParentRunId.has(entry.parentRunId)) return false;
    return true;
  });
  const flatEntries = uniqueFlatEntries([...singleChildEntries, ...visibleFlatEntries]);

  return { groupRows, flatEntries, membersByParentRunId, approvalParentRunIds };
}

/** One unit per rendered queue card / flat row (StatPills ALL + WorkflowRail). */
export function countTopLevelQueueSurfaceRows(input: BuildTrackerQueueSurfacesInput): number {
  const { groupRows, flatEntries } = buildTrackerQueueSurfaces(input);
  return groupRows.length + flatEntries.length;
}
