import type { TrackerEntry } from "./jsonl.js";
import { isDelegatedOcrAwaitingApprovalEntry } from "./dashboard/prep-rows.js";
import { countTopLevelQueueSurfaceRows } from "./queue-surfaces.js";

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
    const sorted = [...bucket].sort((a, b) =>
      activityTimestamp(b).localeCompare(activityTimestamp(a)),
    );
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
  return e.workflow === "ocr" || e.data?.mode === "prepare" || e.id.startsWith("ocr-prep-");
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
function rollupBatchMembersToQueueStripSynth(
  parentRunId: string,
  members: readonly TrackerEntry[],
): TrackerEntry {
  const wf = members[0]?.workflow ?? "";
  const ts = members[0]?.timestamp ?? new Date().toISOString();

  let status: TrackerEntry["status"];
  if (members.some((m) => isQueueLikeForQueueStrip(m))) {
    status = "pending";
  } else if (members.some((m) => m.status === "running")) {
    status = "running";
  } else if (members.some((m) => m.status === "failed")) {
    status = "failed";
  } else {
    status = "done";
  }

  return {
    workflow: wf || "workflow",
    id: `__queue-strip-batch:${parentRunId}`,
    runId: parentRunId,
    timestamp: ts,
    status,
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
 * - Entries with a shared `parentRunId` collapse to one synthetic row.
 * - Approved prep primaries are omitted when that batch has members (children
 *   carry `parentRunId`; the prep anchor is not double-counted).
 */
export function collapseMergedPrimariesForQueueStrip(entries: readonly TrackerEntry[]): TrackerEntry[] {
  const visible = entries.filter((e) => !isDiscardedPrepForQueueStrip(e));

  const batchMembersByParent = new Map<string, TrackerEntry[]>();
  for (const e of visible) {
    if (e.workflow === "ocr") continue;
    if (!e.parentRunId) continue;
    const list = batchMembersByParent.get(e.parentRunId) ?? [];
    list.push(e);
    batchMembersByParent.set(e.parentRunId, list);
  }

  const synthBatches: TrackerEntry[] = [];
  for (const [parentRunId, members] of batchMembersByParent) {
    synthBatches.push(rollupBatchMembersToQueueStripSynth(parentRunId, members));
  }

  const standalone: TrackerEntry[] = [];
  for (const e of visible) {
    if (e.parentRunId && batchMembersByParent.has(e.parentRunId)) continue;
    if (isApprovedPrepForQueueStrip(e)) continue;
    standalone.push(e);
  }

  return [...standalone, ...synthBatches];
}

/**
 * Rail badge + cross-workflow sidebar count: dedupe by item id → drop resolved
 * prep → merge by emplId → collapse delegation batches (`parentRunId`).
 */
export function countSidebarRowsFromTrackerHistory(
  raw: TrackerEntry[],
  isExcluded: (e: TrackerEntry) => boolean,
): number {
  const deduped = dedupeLatestByIdWithCarriedEmplId(raw);
  const visible = deduped.filter((e) => !isExcluded(e));
  const primaries = groupMergedTrackerEntries(visible).map((g) => g.primary);
  return countTopLevelQueueSurfaceRows({
    entries: primaries,
    delegationSourceEntries: visible,
  });
}
