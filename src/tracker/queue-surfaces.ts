import { resolveRowArchetype, type RowArchetype } from "../domain/row-archetype.js";
import { runIdFragment, tracePrefix } from "../domain/queue-trace-id.js";
import {
  getWorkflowRuntimePolicy,
  type WorkflowRuntimePolicyLookup,
} from "../domain/workflow-runtime/registry.js";
import type { TrackerEntry } from "./jsonl.js";
import { isDelegatedOcrAwaitingApprovalEntry } from "./dashboard/prep-rows.js";

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

function isLegacyBatchAnchor(entry: TrackerEntry): boolean {
  const stamped = entry.data?.archetype;
  return stamped === "batch" && !isPreviewAnchor(entry);
}

function isOperationAnchor(entry: TrackerEntry): boolean {
  const shape = classifyTrackerRow(entry).shape;
  return shape === "operation" || isLegacyBatchAnchor(entry);
}

function isPreviewAnchor(entry: TrackerEntry): boolean {
  const classification = classifyTrackerRow(entry);
  if (classification.shape === "preview") return true;
  // Compatibility for older OCR JSONL rows written before `preview` became a
  // first-class archetype. Forward writes should stamp `preview`.
  return entry.data?.archetype === "batch" && entry.workflow === "ocr" && entry.data?.mode === "prepare";
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

function forcesOperationWhenDelegated(
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
    if (!isOperationAnchor(entry)) continue;
    const policy = getWorkflowRuntimePolicy(entry.workflow, runtimePolicies);
    if (policy.delegation?.rootRowPersistsThroughChildren) {
      runIds.add(runIdFor(entry));
    }
  }
  return runIds;
}

function isVisiblePreviewAnchor(e: TrackerEntry): boolean {
  return isPreviewAnchor(e) && !isDiscardedPreviewRow(e);
}

function runIdFor(entry: Pick<TrackerEntry, "id" | "runId">): string {
  return entry.runId ?? entry.id;
}

function buildSyntheticOperationParent(parentRunId: string, members: TrackerEntry[]): TrackerEntry {
  const first = members[0]!;
  const memberTrace = first.data?.__traceId;
  const prefix =
    typeof memberTrace === "string" && memberTrace.length > 0 ? tracePrefix(memberTrace) : undefined;
  const tail = runIdFragment(parentRunId);
  const composedTrace = prefix && tail ? `${prefix}-${tail}` : undefined;
  return {
    workflow: first.workflow,
    timestamp: first.timestamp,
    id: `input-run-${parentRunId.slice(0, 8)}`,
    runId: parentRunId,
    status: "pending",
    data: {
      archetype: "operation",
      ...(composedTrace ? { __traceId: composedTrace } : {}),
    },
  };
}

function buildMembersByParentRunId(
  entries: TrackerEntry[],
  rootPersistingRunIds: Set<string>,
): Map<string, TrackerEntry[]> {
  const map = new Map<string, TrackerEntry[]>();
  for (const entry of entries) {
    if (!entry.parentRunId) continue;
    if ((isOperationAnchor(entry) || isVisiblePreviewAnchor(entry)) && !rootPersistingRunIds.has(entry.parentRunId)) {
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

/**
 * Lightweight OCR status link surfaced on an operation row before approval.
 * The live `status`/`step` are read from the linked OCR row when present in the
 * source entries (cross-workflow), falling back to the values denormalized onto
 * the operation row's own `data.ocrStatus`/`data.ocrStep` at prepare time. This
 * is a status/link join — the full OCR review row stays in the OCR panel and is
 * never duplicated into the operation surface.
 */
export interface TrackerOperationOcrLink {
  runId?: string;
  sessionId?: string;
  status: string;
  step?: string;
}

export interface TrackerOperationSurface {
  kind: "operation";
  parentRunId: string;
  parent: TrackerEntry;
  members: TrackerEntry[];
  ocr?: TrackerOperationOcrLink;
  titleOverride?: string;
}

export type TrackerQueueGroupSurface =
  | TrackerPreviewSurface
  | TrackerOperationSurface;

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

function stringData(entry: TrackerEntry, key: string): string | undefined {
  const value = entry.data?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Resolve the lightweight OCR status link for an operation row from the values
 * denormalized onto the row at prepare time and kept fresh by the OCR
 * orchestrator / approve / discard paths (`data.ocrRunId`, `data.ocrSessionId`,
 * `data.ocrStatus`, `data.ocrStep`).
 *
 * The OCR review row itself lives in the OCR workflow's panel — it is NEVER in
 * this (target-workflow) panel's entries (the entries payload is workflow
 * scoped, `WHERE workflow = @workflow`), so a cross-workflow row lookup would
 * never fire in production. The operation row carries its own copy of the OCR
 * status for display; the full review UI stays in the OCR panel.
 */
function resolveOperationOcrLink(parent: TrackerEntry): TrackerOperationOcrLink | undefined {
  const ocrRunId = stringData(parent, "ocrRunId");
  const ocrSessionId = stringData(parent, "ocrSessionId");
  const status = stringData(parent, "ocrStatus");
  const step = stringData(parent, "ocrStep");
  if (!ocrRunId && !status) return undefined;
  return {
    ...(ocrRunId ? { runId: ocrRunId } : {}),
    ...(ocrSessionId ? { sessionId: ocrSessionId } : {}),
    status: status ?? "running",
    ...(step ? { step } : {}),
  };
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
  const operationAnchors = visibleEntries.filter(isOperationAnchor);
  const previewAnchors = visibleEntries.filter(isVisiblePreviewAnchor);
  const operationAnchorRunIds = new Set(operationAnchors.map((entry) => entry.runId ?? entry.id));
  const previewAnchorRunIds = new Set(previewAnchors.map((entry) => entry.runId ?? entry.id));
  const anchoredParentRunIds = new Set([...operationAnchorRunIds, ...previewAnchorRunIds]);
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

  for (const parent of operationAnchors) {
    const parentRunId = parent.runId ?? parent.id;
    const members = membersByParentRunId.get(parentRunId) ?? [];
    const ocr = resolveOperationOcrLink(parent);
    const titleOverride = titleOverrideForAnchor(parent);
    groupRows.push({
      kind: "operation",
      parentRunId,
      parent,
      members,
      ...(ocr ? { ocr } : {}),
      ...(titleOverride ? { titleOverride } : {}),
    });
  }

  for (const [parentRunId, members] of membersByParentRunId) {
    if (anchoredParentRunIds.has(parentRunId)) continue;
    // A lone delegated child normally renders as a flat single row — unless its
    // workflow opts into `alwaysBatchDelegatedMembers` (oath-signature,
    // person-lookup), where even one member stays a one-member operation surface.
    if (members.length === 1 && !forcesOperationWhenDelegated(members[0]!, input.runtimePolicies)) {
      singleChildEntries.push(members[0]!);
      continue;
    }
    groupRows.push({
      kind: "operation",
      parentRunId,
      parent: buildSyntheticOperationParent(parentRunId, members),
      members,
    });
  }

  const groupedParentRunIds = new Set(groupRows.map((surface) => surface.parentRunId));
  const visibleFlatEntries = visibleEntries.filter((entry) => {
    if (isOperationAnchor(entry) || isVisiblePreviewAnchor(entry)) {
      return false;
    }
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

function isAuthRunningEntry(entry: TrackerEntry): boolean {
  return entry.status === "running" && Boolean(entry.step?.startsWith("auth:"));
}

/**
 * A row that occupies the queue (not yet running its real work and not
 * terminal). Mirrors the dashboard's `isQueueLikeEntry` + the queue strip's
 * `isQueueLikeForQueueStrip` (pending / skipped / authenticating / a delegated
 * OCR row parked at awaiting-approval) so the collapsed-queued count matches the
 * panel's "N Queue" status filter.
 */
function isQueueLikeEntry(entry: TrackerEntry): boolean {
  return (
    entry.status === "pending" ||
    entry.status === "skipped" ||
    isAuthRunningEntry(entry) ||
    isDelegatedOcrAwaitingApprovalEntry(entry)
  );
}

/** A flat row or group surface counts as queued if its anchor or any member is queue-like. */
function surfaceIsQueued(surface: TrackerQueueGroupSurface): boolean {
  if (surface.members.length > 0) {
    // Member status drives queued for grouped surfaces — synthetic operation
    // shells always stamp `pending` even when every member is terminal.
    return surface.members.some((m) => isQueueLikeEntry(m));
  }
  const parent = "parent" in surface ? surface.parent : undefined;
  if (parent && isQueueLikeEntry(parent)) return true;
  return false;
}

/**
 * Collapsed top-level **queued** surface count — the queue-surface analogue of
 * the panel's "N Queue" status filter, computed by the SAME collapse logic that
 * produces the rail total ({@link countTopLevelQueueSurfaceRows}). A delegated-
 * member workflow (person-lookup) collapses many queued members into one queued
 * batch ANCHOR, so this returns the number of queued anchors, never the raw
 * member count — keeping `queued <= total` (ISS-002). For a non-delegated single
 * workflow (oath-upload tickets) every queued surface is one queued row, so
 * collapsed-queued equals the raw queued depth there.
 */
export function countQueuedTopLevelQueueSurfaceRows(input: BuildTrackerQueueSurfacesInput): number {
  const { groupRows, flatEntries } = buildTrackerQueueSurfaces(input);
  const queuedGroups = groupRows.filter(surfaceIsQueued).length;
  const queuedFlat = flatEntries.filter(isQueueLikeEntry).length;
  return queuedGroups + queuedFlat;
}
