import type { TrackerEntry } from "@/components/shared/types";
import { isApprovedPrepRow, isDiscardedPrepRow } from "@/components/ocr/types";

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
  const approvalParents = visibleEntries.filter(isApprovedPrepRow);
  const approvalParentRunIds = new Set(approvalParents.map((entry) => entry.runId ?? entry.id));

  const groupRows: QueueGroupSurface[] = approvalParents.map((parent) => {
    const parentRunId = parent.runId ?? parent.id;
    return {
      kind: "approval-delegation",
      parentRunId,
      parent,
      members: membersByParentRunId.get(parentRunId) ?? [],
      approvalState: "approved",
    };
  });

  for (const [parentRunId, members] of membersByParentRunId) {
    if (approvalParentRunIds.has(parentRunId)) continue;
    groupRows.push({
      kind: "batch",
      parentRunId,
      members,
    });
  }

  const groupedParentRunIds = new Set(groupRows.map((surface) => surface.parentRunId));
  const flatEntries = visibleEntries.filter((entry) => {
    if (isApprovedPrepRow(entry)) return false;
    if (entry.parentRunId && groupedParentRunIds.has(entry.parentRunId)) return false;
    if (entry.parentRunId && membersByParentRunId.has(entry.parentRunId)) return false;
    return true;
  });

  return { groupRows, flatEntries, membersByParentRunId, approvalParentRunIds };
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
