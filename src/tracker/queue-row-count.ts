import type { TrackerEntry } from "./jsonl.js";
import { isDelegatedOcrAwaitingApprovalEntry } from "./dashboard/prep-rows.js";
import {
  countQueuedTopLevelQueueSurfaceRows,
  countTopLevelQueueSurfaceRows,
} from "./queue-surfaces.js";
import { resolveRowArchetype } from "../domain/row-archetype.js";
import type { WorkflowRuntimePolicyLookup } from "../domain/workflow-runtime/registry.js";
import { isUcpathEmployeeId } from "../domain/identity/eid.js";

/** SSE payloads may enrich rows; JSONL replay may omit this — both are valid. */
function activityTimestamp(e: TrackerEntry): string {
  const first = (e as TrackerEntry & { firstLogTs?: string }).firstLogTs;
  return (typeof first === "string" && first.length > 0 ? first : null) || e.timestamp || "";
}

/**
 * Dashboard queue collapses multiple tracker items that resolve to the same
 * employee id (`data.emplId`) into one row. Sidebar `wfCounts` combine that
 * merge with the queue **surface** model ({@link countTopLevelQueueSurfaceRows})
 * so delegated children inside one card are not counted separately from the card.
 */
export interface MergedEntryGroup {
  primary: TrackerEntry;
  siblings: TrackerEntry[];
}

function canonicalMergeKey(e: TrackerEntry): string {
  const eid = e.data?.emplId;
  return typeof eid === "string" && eid.length > 0 ? eid : e.id;
}

/**
 * True when this row's Search field is an EID-keyed lookup (typed EID, or
 * `__subjectKind: "eid"`). Used so a name-search sibling doesn't become the
 * merge primary and overwrite Search with the resolved person name.
 */
function isEidKeyedSearch(e: TrackerEntry): boolean {
  const data = e.data ?? {};
  if (data.__subjectKind === "eid") return true;
  const searchName = typeof data.searchName === "string" ? data.searchName.trim() : "";
  if (searchName && isUcpathEmployeeId(searchName)) return true;
  // Direct EID input runs use the EID as the tracker item id.
  return isUcpathEmployeeId(e.id);
}

/**
 * Prefer an EID-keyed search as the merge primary so the log-panel Search
 * field shows the original query (EID) rather than a later name-search
 * sibling's typed name. Among the same kind, newest activity wins.
 */
function compareMergedPrimaries(a: TrackerEntry, b: TrackerEntry): number {
  const aEid = isEidKeyedSearch(a);
  const bEid = isEidKeyedSearch(b);
  if (aEid !== bEid) return aEid ? -1 : 1;
  return activityTimestamp(b).localeCompare(activityTimestamp(a));
}

export function groupMergedTrackerEntries(entries: TrackerEntry[]): MergedEntryGroup[] {
  const buckets = new Map<string, TrackerEntry[]>();
  for (const e of entries) {
    const key = canonicalMergeKey(e);
    const bucket = buckets.get(key) ?? [];
    bucket.push(e);
    buckets.set(key, bucket);
  }
  const groups: MergedEntryGroup[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length === 1) {
      groups.push({ primary: bucket[0], siblings: [] });
      continue;
    }
    const sorted = [...bucket].sort(compareMergedPrimaries);
    const [primary, ...siblings] = sorted;
    groups.push({ primary, siblings });
  }
  return groups;
}

/** Latest row per tracker `id`, with `emplId` carried forward from older lines (matches dashboard `useEntries`). */
export function dedupeLatestByIdWithCarriedEmplId(raw: TrackerEntry[]): TrackerEntry[] {
  const latest = new Map<string, TrackerEntry>();
  const resolvedEmplIds = new Map<string, string>();

  for (const entry of raw) {
    const prev = latest.get(entry.id);
    if (!prev || prev.timestamp <= entry.timestamp) {
      latest.set(entry.id, entry);
    }
    const emplId = entry.data?.emplId;
    if (typeof emplId === "string" && emplId.length > 0) {
      resolvedEmplIds.set(entry.id, emplId);
    }
  }

  return [...latest.values()].map((entry) => {
    const carried = resolvedEmplIds.get(entry.id);
    const data =
      carried && (!entry.data?.emplId || entry.data.emplId.length === 0)
        ? { ...(entry.data ?? {}), emplId: carried }
        : entry.data;
    return { ...entry, data };
  });
}

function isPrepareMode(e: TrackerEntry): boolean {
  return resolveRowArchetype(e) === "operation" && e.data?.mode === "prepare";
}

function isDiscardedPrepForQueueStrip(e: TrackerEntry): boolean {
  if (!isPrepareMode(e)) return false;
  return e.status === "failed" && e.step === "discarded";
}

function isApprovedPrepForQueueStrip(e: TrackerEntry): boolean {
  if (e.workflow === "ocr") return false;
  if (!isPrepareMode(e)) return false;
  return e.status === "done" && e.step === "approved";
}

function isAuthRunningForQueueStrip(e: TrackerEntry): boolean {
  return e.status === "running" && Boolean(e.step?.startsWith("auth:"));
}

/**
 * Canonical status key for rollup bucketing. Mirrors the dashboard's
 * `statusKeyForEntry` cancelled/discarded override: a deliberate operator
 * action — `failed` + step `cancelled`/`discarded` — is reported as
 * `"cancelled"`, not `"failed"` (E2E-009). Inlined because the tracker layer
 * must not import dashboard code (it would cycle and pull React into a
 * server-safe module); the same one-line override is already inlined across
 * this layer (e.g. `isDiscardedPrepForQueueStrip` above, `dashboard/failures.ts`).
 */
function rollupStatusKey(e: TrackerEntry): string {
  if (e.status === "failed" && (e.step === "cancelled" || e.step === "discarded")) {
    return "cancelled";
  }
  return e.status;
}

function isQueueLikeForQueueStrip(e: TrackerEntry): boolean {
  return (
    e.status === "pending" ||
    e.status === "skipped" ||
    isAuthRunningForQueueStrip(e) ||
    // Only delegated (parentRunId-bearing) awaiting-approval rows belong in
    // the upstream queue surface. Standalone OCR previews persist as
    // "awaiting-approval" indefinitely until the operator acts on them; if
    // included here they'd inflate the per-rebuild scan monotonically with
    // review backlog.
    isDelegatedOcrAwaitingApprovalEntry(e)
  );
}

/**
 * One synthetic row per `parentRunId` batch (daemon / OCR delegation batch row),
 * matching daemon batch rollup + StatPills semantics.
 */
function rollupOperationMembersToQueueStripSynth(
  parentRunId: string,
  members: readonly TrackerEntry[],
): TrackerEntry {
  const wf = members[0]?.workflow ?? "";
  const ts = members[0]?.timestamp ?? new Date().toISOString();

  // Classify members by their CANONICAL status key (cancelled/discarded override
  // applied) so a cancelled member (failed + step=cancelled) rolls up to
  // "cancelled", not "failed" (ISS-010). Precedence: any queued work → pending;
  // else any running → running; else a GENUINE failure with NOTHING succeeded →
  // failed; else a cancellation → cancelled; else done.
  //
  // A partial failure rolls up to DONE, matching the coordinator CARD, which
  // renders via `rollupOperationStatus` (`src/domain/operation-status.ts`) and
  // deliberately refuses to let a failed member promote the operation to failed
  // (E2E-106). A partial failure is normal — an I-9 batch where 25 people
  // resolve and 5 don't is a completed operation with per-member outcomes, and
  // the failed count is already surfaced by the row's StatusCounts badge. Only a
  // wholesale failure (no member succeeded) reads as Failed here. The `!done`
  // gate — rather than "every member failed" — preserves the older rule that a
  // genuine failure outranks a cancel when nothing succeeded.
  const keys = members.map(rollupStatusKey);
  let status: TrackerEntry["status"];
  let step: string | undefined;
  if (members.some((m) => isQueueLikeForQueueStrip(m))) {
    status = "pending";
  } else if (keys.some((k) => k === "running")) {
    status = "running";
  } else if (keys.some((k) => k === "failed") && !keys.some((k) => k === "done")) {
    status = "failed";
  } else if (keys.some((k) => k === "cancelled")) {
    // Emit the cancelled SHAPE (failed + step=cancelled) so the downstream
    // countEntriesByQueueStatus → statusKeyForEntry buckets it as cancelled.
    status = "failed";
    step = "cancelled";
  } else {
    status = "done";
  }

  return {
    workflow: wf || "workflow",
    id: `__queue-strip-batch:${parentRunId}`,
    runId: parentRunId,
    timestamp: ts,
    status,
    ...(step ? { step } : {}),
    data: {},
  };
}

/**
 * Legacy “queue strip” row list used for StatPills **per-status** counts on
 * collapsed primaries. **Sidebar badges and SSE `wfCounts`** use
 * {@link countTopLevelQueueSurfaceRows} instead — it matches delegation/batch
 * cards and avoids double-counting children that render inside a group row.
 *
 * - Discarded prep rows are dropped.
 * - Entries with a shared `parentRunId` collapse to one synthetic row whose
 *   status is the canonical rollup of its members (cancelled ≠ failed).
 * - Approved prep primaries are omitted when that batch has members (children
 *   carry `parentRunId`; the prep anchor is not double-counted).
 * - Operation coordinators (and any real parent row whose members rolled up to
 *   a synth) are omitted too — the synth represents them, so a perpetual
 *   `running`/`step=approved` coordinator does not double-count as Active.
 */
export function collapseMergedPrimariesForQueueStrip(entries: readonly TrackerEntry[]): TrackerEntry[] {
  const visible = entries.filter((e) => !isDiscardedPrepForQueueStrip(e));

  const operationMembersByParent = new Map<string, TrackerEntry[]>();
  for (const e of visible) {
    // OCR entries are direct-delegation children of oath-upload, not fan-out
    // batch members — keep them out of the batch rollup even after archetype migration.
    if (e.workflow === "ocr") continue;
    if (!e.parentRunId) continue;
    const list = operationMembersByParent.get(e.parentRunId) ?? [];
    list.push(e);
    operationMembersByParent.set(e.parentRunId, list);
  }

  const synthOperations: TrackerEntry[] = [];
  for (const [parentRunId, members] of operationMembersByParent) {
    synthOperations.push(rollupOperationMembersToQueueStripSynth(parentRunId, members));
  }

  const standalone: TrackerEntry[] = [];
  for (const e of visible) {
    if (e.parentRunId && operationMembersByParent.has(e.parentRunId)) continue;
    // An operation coordinator (or any real parent row whose members were
    // collected into a synth rollup above) is REPRESENTED by that synth — drop
    // it so the operation isn't double-counted (coordinator row + synth) and so
    // the synth's rolled-up status drives the bucket instead of the coordinator's
    // perpetual running/step=approved (ISS-005). Batch prep anchors are also
    // dropped via isApprovedPrepForQueueStrip below; operation coordinators are
    // archetype "operation" (not "batch") and never reach a terminal row, so
    // that done+approved check never catches them — this does.
    if (e.runId && operationMembersByParent.has(e.runId)) continue;
    if (isApprovedPrepForQueueStrip(e)) continue;
    standalone.push(e);
  }

  return [...standalone, ...synthOperations];
}

/**
 * Shared collapse pipeline for both the rail TOTAL and the rail QUEUED counts:
 * dedupe by item id → drop resolved prep → merge by emplId → (the caller then
 * collapses delegation batches via the queue-surface model).
 */
function collapseSidebarSurfaceInput(
  raw: TrackerEntry[],
  isExcluded: (e: TrackerEntry) => boolean,
  runtimePolicies?: WorkflowRuntimePolicyLookup,
): { entries: TrackerEntry[]; delegationSourceEntries: TrackerEntry[]; runtimePolicies?: WorkflowRuntimePolicyLookup } {
  const deduped = dedupeLatestByIdWithCarriedEmplId(raw);
  const visible = deduped.filter((e) => !isExcluded(e));
  const primaries = groupMergedTrackerEntries(visible).map((g) => g.primary);
  return {
    entries: primaries,
    delegationSourceEntries: visible,
    ...(runtimePolicies ? { runtimePolicies } : {}),
  };
}

/**
 * Rail badge + cross-workflow sidebar count: dedupe by item id → drop resolved
 * prep → merge by emplId → collapse delegation batches (`parentRunId`).
 */
export function countSidebarRowsFromTrackerHistory(
  raw: TrackerEntry[],
  isExcluded: (e: TrackerEntry) => boolean = () => false,
  runtimePolicies?: WorkflowRuntimePolicyLookup,
): number {
  return countTopLevelQueueSurfaceRows(
    collapseSidebarSurfaceInput(raw, isExcluded, runtimePolicies),
  );
}

/**
 * Rail "queued" sub-badge count — the QUEUED slice of the same collapsed
 * top-level-surface model as {@link countSidebarRowsFromTrackerHistory}, so the
 * sub-badge is always `<= total`. For a delegated-member workflow (person-lookup)
 * this collapses many queued members into one queued ANCHOR, never the raw member
 * count; for a non-delegated single workflow (oath-upload tickets) it equals the
 * raw queued depth. Replaces the rail's prior raw `readQueueDepth` read (ISS-002).
 */
export function countSidebarQueuedRowsFromTrackerHistory(
  raw: TrackerEntry[],
  isExcluded: (e: TrackerEntry) => boolean = () => false,
  runtimePolicies?: WorkflowRuntimePolicyLookup,
): number {
  return countQueuedTopLevelQueueSurfaceRows(
    collapseSidebarSurfaceInput(raw, isExcluded, runtimePolicies),
  );
}
