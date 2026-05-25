import { resolveRowArchetype } from "../domain/row-archetype.js";
import {
  getWorkflowRuntimePolicy,
  type WorkflowRuntimePolicyLookup,
} from "../domain/workflow-runtime/registry.js";
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

function isBatchParentAnchor(e: TrackerEntry): boolean {
  return isBatchParent(e) && !isDiscardedPrepRow(e);
}

function isPassiveDelegationMember(entry: TrackerEntry): boolean {
  return resolveRowArchetype(entry) === "passive-child";
}

/** Policy-declared utility fan-out children stay as flat delegation member rows. */
function isPolicyUtilityDelegationMember(
  entry: TrackerEntry,
  runtimePolicies?: WorkflowRuntimePolicyLookup,
): boolean {
  if (resolveRowArchetype(entry) !== "delegate-child") return false;
  const originWorkflow = entry.data?.originWorkflow;
  if (typeof originWorkflow !== "string" || !originWorkflow) return false;
  const policy = getWorkflowRuntimePolicy(originWorkflow, runtimePolicies);
  if (policy.delegation?.utilityChildSurface !== "delegation-member") return false;
  const workflows = policy.delegation.utilityChildWorkflows ?? [];
  return workflows.includes(entry.workflow);
}

function runIdFor(entry: Pick<TrackerEntry, "id" | "runId">): string {
  return entry.runId ?? entry.id;
}

function rootPersistingParentRunIds(
  entries: TrackerEntry[],
  runtimePolicies?: WorkflowRuntimePolicyLookup,
): Set<string> {
  const runIds = new Set<string>();
  for (const entry of entries) {
    if (!isBatchParentAnchor(entry)) continue;
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
    if (isBatchParent(entry) && !rootPersistingRunIds.has(entry.parentRunId)) continue; // batch-parent rows are anchors, not members
    const list = map.get(entry.parentRunId) ?? [];
    list.push(entry);
    map.set(entry.parentRunId, list);
  }
  return map;
}

function groupPendingDelegatedBatchParents(
  entries: TrackerEntry[],
  rootPersistingRunIds: Set<string>,
): Map<string, TrackerEntry[]> {
  const map = new Map<string, TrackerEntry[]>();
  for (const entry of entries) {
    if (!entry.parentRunId) continue;
    if (rootPersistingRunIds.has(entry.parentRunId)) continue;
    if (!isBatchParentAnchor(entry)) continue;
    if (isApprovedPrepRow(entry)) continue;
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
  titleOverride?: string;
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
  runtimePolicies?: WorkflowRuntimePolicyLookup;
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
  const rootPersistingRunIds = rootPersistingParentRunIds(visibleSources, input.runtimePolicies);
  const membersByParentRunId = buildMembersByParentRunId(visibleSources, rootPersistingRunIds);
  const batchParentAnchors = visibleEntries.filter(isBatchParentAnchor);
  const batchParentAnchorRunIds = new Set(batchParentAnchors.map((entry) => entry.runId ?? entry.id));
  const approvalParentRunIds = new Set([...batchParentAnchorRunIds]);
  const pendingDelegatedBatchParentsByParentRunId =
    groupPendingDelegatedBatchParents(batchParentAnchors, rootPersistingRunIds);
  const pendingDelegatedBatchParentRunIds = new Set<string>();
  const singleDelegationEntries: TrackerEntry[] = [];

  const groupRows: TrackerQueueGroupSurface[] = [];

  for (const [parentRunId, members] of pendingDelegatedBatchParentsByParentRunId) {
    for (const member of members) {
      pendingDelegatedBatchParentRunIds.add(member.runId ?? member.id);
    }
    if (members.length === 1) {
      singleDelegationEntries.push(members[0]!);
      continue;
    }
    groupRows.push({
      kind: "batch",
      parentRunId,
      members,
      titleOverride: members[0]?.data?.parentSubject,
    });
  }

  for (const parent of batchParentAnchors) {
    const parentRunId = parent.runId ?? parent.id;
    if (pendingDelegatedBatchParentRunIds.has(parentRunId)) continue;
    const members = membersByParentRunId.get(parentRunId) ?? [];
    const approved = isApprovedPrepRow(parent);

    if (approved && members.length === 0) {
      // Approved parent with no visible members stays flat — downstream
      // entries live in a different workflow's queue (e.g. the OCR tab
      // showing a prep row whose signer children are oath-signature rows).
      // Row type must not change after approval.
      continue;
    }

    // A prep/upload batch-parent represents one operator upload action, so
    // it stays an approval-delegation card regardless of approval state and
    // signer count. A single-signer PDF must not collapse into a flat row
    // after OCR approval — that would change the row type mid-lifecycle.
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
      if (isPolicyUtilityDelegationMember(only, input.runtimePolicies)) {
        singleDelegationEntries.push(only);
      } else if (isPassiveDelegationMember(only)) {
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
    if (members.every((member) => isPolicyUtilityDelegationMember(member, input.runtimePolicies))) {
      singleDelegationEntries.push(...members);
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
