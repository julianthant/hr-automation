import type { TrackerEntry } from "@/components/shared/types";
import { isApprovedPrepRow, isDiscardedPrepRow, isPrepBatchAnchor } from "@/components/ocr/types";

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
  const visibleEntries = input.entries.filter((entry) => !isDiscardedPrepRow(entry));
  const visibleSources = input.delegationSourceEntries.filter(
    (entry) => !isDiscardedPrepRow(entry),
  );
  const membersByParentRunId = buildMembersByParentRunId(visibleSources);
  // Prep batch anchors (non-OCR prep rows) always own a group surface regardless
  // of approval state. OCR-workflow rows continue using the isApprovedPrepRow path.
  const prepBatchAnchors = visibleEntries.filter(isPrepBatchAnchor);
  const prepBatchAnchorRunIds = new Set(prepBatchAnchors.map((entry) => entry.runId ?? entry.id));
  // OCR-workflow approval parents (kept for the OCR-workflow review flow).
  const ocrApprovalParents = visibleEntries.filter(
    (entry) => entry.workflow === "ocr" && isApprovedPrepRow(entry),
  );
  const approvalParentRunIds = new Set([
    ...prepBatchAnchorRunIds,
    ...ocrApprovalParents.map((entry) => entry.runId ?? entry.id),
  ]);
  const singleDelegationEntries: TrackerEntry[] = [];

  const groupRows: QueueGroupSurface[] = [];

  // Prep batch anchors: always grouped, never collapsed to a single flat entry.
  for (const parent of prepBatchAnchors) {
    const parentRunId = parent.runId ?? parent.id;
    const members = membersByParentRunId.get(parentRunId) ?? [];
    groupRows.push({
      kind: "approval-delegation",
      parentRunId,
      parent,
      members,
      approvalState: isApprovedPrepRow(parent) ? "approved" : "awaiting-approval",
    });
  }

  // OCR-workflow approved delegations (single-member may collapse to flat).
  for (const parent of ocrApprovalParents) {
    const parentRunId = parent.runId ?? parent.id;
    const members = membersByParentRunId.get(parentRunId) ?? [];
    if (members.length === 1) {
      singleDelegationEntries.push(members[0]!);
      continue;
    }
    groupRows.push({
      kind: "approval-delegation",
      parentRunId,
      parent,
      members,
      approvalState: "approved",
    });
  }

  for (const [parentRunId, members] of membersByParentRunId) {
    if (approvalParentRunIds.has(parentRunId)) continue;
    if (members.length === 1) {
      singleDelegationEntries.push(members[0]!);
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
    if (isPrepBatchAnchor(entry)) return false;
    if (isApprovedPrepRow(entry)) return false;
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

function isPassiveDelegationMember(entry: TrackerEntry): boolean {
  return entry.data?.taskRole === "utility" && Boolean(entry.data?.originWorkflow);
}

function buildMembersByParentRunId(entries: TrackerEntry[]): Map<string, TrackerEntry[]> {
  const map = new Map<string, TrackerEntry[]>();
  for (const entry of entries) {
    if (!entry.parentRunId) continue;
    if (entry.workflow === "ocr") continue;
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
