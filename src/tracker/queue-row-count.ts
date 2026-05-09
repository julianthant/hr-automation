import type { TrackerEntry } from "./jsonl.js";

/** SSE payloads may enrich rows; JSONL replay may omit this — both are valid. */
function activityTimestamp(e: TrackerEntry): string {
  const first = (e as TrackerEntry & { firstLogTs?: string }).firstLogTs;
  return (typeof first === "string" && first.length > 0 ? first : null) || e.timestamp || "";
}

/**
 * Dashboard queue collapses multiple tracker items that resolve to the same
 * employee id (`data.emplId`) into one row. Sidebar `wfCounts` must use the
 * same grouping — counting raw item_ids would over-count (e.g. name + EID
 * checks for one person).
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

/** Rail badge count: dedupe by item id → drop resolved prep rows → merge by emplId. */
export function countSidebarRowsFromTrackerHistory(
  raw: TrackerEntry[],
  isExcluded: (e: TrackerEntry) => boolean,
): number {
  const deduped = dedupeLatestByIdWithCarriedEmplId(raw);
  const visible = deduped.filter((e) => !isExcluded(e));
  return groupMergedTrackerEntries(visible).length;
}
