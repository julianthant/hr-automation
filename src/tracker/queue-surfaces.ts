import { resolveRowArchetype } from "../domain/row-archetype.js";
import type { TrackerEntry } from "./jsonl.js";

function isBatchParent(e: TrackerEntry): boolean {
  return resolveRowArchetype(e) === "batch-parent";
}

function isDiscardedPrepRow(e: TrackerEntry): boolean {
  if (!isBatchParent(e)) return false;
  return e.status === "failed" && e.step === "discarded";
}

function isApprovedPrepRow(e: TrackerEntry): boolean {
  if (!isBatchParent(e)) return false;
  return e.status === "done" && e.step === "approved";
}

function isBatchParentAnchor(e: TrackerEntry): boolean {
  return isBatchParent(e) && !isDiscardedPrepRow(e);
}

function isPassiveDelegationMember(entry: TrackerEntry): boolean {
  return resolveRowArchetype(entry) === "passive-child";
}

/** OCR prep fans out daemon utility rows with `taskRole: "child"` — same group card as passive utility. */
function isOcrDaemonPrepFanoutChild(entry: TrackerEntry): boolean {
  return (
    resolveRowArchetype(entry) === "delegate-child" &&
    entry.data?.originWorkflow === "ocr" &&
    (entry.workflow === "eid-lookup" || entry.workflow === "active-check")
  );
}

function isPassiveDelegationSurfaceMember(entry: TrackerEntry): boolean {
  return isPassiveDelegationMember(entry) || isOcrDaemonPrepFanoutChild(entry);
}

function buildMembersByParentRunId(entries: TrackerEntry[]): Map<string, TrackerEntry[]> {
  const map = new Map<string, TrackerEntry[]>();
  for (const entry of entries) {
    if (!entry.parentRunId) continue;
    if (isBatchParent(entry)) continue; // batch-parent rows are anchors, not members
    const list = map.get(entry.parentRunId) ?? [];
    list.push(entry);
    map.set(entry.parentRunId, list);
  }
  return map;
}

function uniqueFlatEntries(entries: TrackerEntry[]): TrackerEntry[] {
  const byKey = new Map<string, TrackerEntry>();
  for (const entry of entries) {
    byKey.set(`${entry.workflow}\0${entry.id}\0${entry.runId ?? ""}`, entry);
  }
  return [...byKey.values()];
}

export interface TrackerApprovalDelegationSurface {
  kind: "approval-delegation";
  parentRunId: string;
  parent: TrackerEntry;
  members: TrackerEntry[];
  approvalState: "awaiting-approval" | "approved" | "discarded";
}

export interface TrackerPassiveDelegationSurface {
  kind: "passive-delegation";
  parentRunId: string;
  members: TrackerEntry[];
  titleOverride?: string;
}

export interface TrackerBatchSurface {
  kind: "batch";
  parentRunId: string;
  members: TrackerEntry[];
  titleOverride?: string;
}

export type TrackerQueueGroupSurface =
  | TrackerApprovalDelegationSurface
  | TrackerPassiveDelegationSurface
  | TrackerBatchSurface;

export interface TrackerQueueSurfaces {
  groupRows: TrackerQueueGroupSurface[];
  flatEntries: TrackerEntry[];
  membersByParentRunId: Map<string, TrackerEntry[]>;
  approvalParentRunIds: Set<string>;
}

export interface BuildTrackerQueueSurfacesInput {
  entries: TrackerEntry[];
  delegationSourceEntries: TrackerEntry[];
}

/**
 * Canonical queue **surface** model: one group card + zero or more flat rows.
 * Shared by dashboard `buildQueueSurfaces` and sidebar / wfCounts aggregation
 * so digits never double-count delegated children that render inside a card.
 */
export function buildTrackerQueueSurfaces(input: BuildTrackerQueueSurfacesInput): TrackerQueueSurfaces {
  const visibleEntries = input.entries.filter((entry) => !isDiscardedPrepRow(entry));
  const visibleSources = input.delegationSourceEntries.filter(
    (entry) => !isDiscardedPrepRow(entry),
  );
  const membersByParentRunId = buildMembersByParentRunId(visibleSources);
  const batchParentAnchors = visibleEntries.filter(isBatchParentAnchor);
  const batchParentAnchorRunIds = new Set(batchParentAnchors.map((entry) => entry.runId ?? entry.id));
  const approvalParentRunIds = new Set([...batchParentAnchorRunIds]);
  const singleDelegationEntries: TrackerEntry[] = [];

  const groupRows: TrackerQueueGroupSurface[] = [];

  for (const parent of batchParentAnchors) {
    const parentRunId = parent.runId ?? parent.id;
    const members = membersByParentRunId.get(parentRunId) ?? [];
    const approved = isApprovedPrepRow(parent);

    if (approved) {
      if (members.length === 0) {
        // Approved parent with no visible members stays flat — downstream
        // entries live in a different workflow's queue. Row type must not
        // change after approval.
        continue;
      }
      if (members.length === 1) {
        singleDelegationEntries.push(members[0]!);
        continue;
      }
    }

    groupRows.push({
      kind: "approval-delegation",
      parentRunId,
      parent,
      members,
      approvalState: approved ? "approved" : "awaiting-approval",
    });
  }

  for (const [parentRunId, members] of membersByParentRunId) {
    if (approvalParentRunIds.has(parentRunId)) continue;
    if (members.length === 1) {
      const only = members[0]!;
      if (isPassiveDelegationSurfaceMember(only)) {
        groupRows.push({
          kind: "passive-delegation",
          parentRunId,
          members,
          titleOverride: only.data?.parentSubject,
        });
      } else {
        singleDelegationEntries.push(only);
      }
      continue;
    }
    const passive = members.every(isPassiveDelegationMember);
    groupRows.push({
      kind: passive ? "passive-delegation" : "batch",
      parentRunId,
      members,
      titleOverride: passive ? members[0]?.data?.parentSubject : undefined,
    });
  }

  const groupedParentRunIds = new Set(groupRows.map((surface) => surface.parentRunId));
  const visibleFlatEntries = visibleEntries.filter((entry) => {
    if (isBatchParentAnchor(entry)) {
      if (isApprovedPrepRow(entry)) {
        // Suppress the approved prep row only when its members are rendered
        // elsewhere (single-delegation entry or group card). With 0 visible
        // members it stays flat — its row type must not change after approval.
        const parentRunId = entry.runId ?? entry.id;
        const members = membersByParentRunId.get(parentRunId) ?? [];
        return members.length === 0;
      }
      return false;
    }
    if (entry.parentRunId && groupedParentRunIds.has(entry.parentRunId)) return false;
    if (entry.parentRunId && membersByParentRunId.has(entry.parentRunId)) return false;
    return true;
  });
  const flatEntries = uniqueFlatEntries([
    ...singleDelegationEntries,
    ...visibleFlatEntries,
  ]);

  return { groupRows, flatEntries, membersByParentRunId, approvalParentRunIds };
}

/** One unit per rendered queue card / flat row (StatPills ALL + WorkflowRail). */
export function countTopLevelQueueSurfaceRows(input: BuildTrackerQueueSurfacesInput): number {
  const { groupRows, flatEntries } = buildTrackerQueueSurfaces(input);
  return groupRows.length + flatEntries.length;
}
