import type { TrackerEntry } from "@/components/shared/types";

export type QueueStatusCounts = Record<string, number>;

export function isAuthRunningEntry(entry: TrackerEntry): boolean {
  return entry.status === "running" && Boolean(entry.step?.startsWith("auth:"));
}

export function isQueueLikeEntry(entry: TrackerEntry): boolean {
  return entry.status === "pending" || entry.status === "skipped" || isAuthRunningEntry(entry);
}

export function entryMatchesStatusFilter(entry: TrackerEntry, statusFilter: string | null): boolean {
  if (!statusFilter) return true;
  if (statusFilter === "pending") return isQueueLikeEntry(entry);
  return entry.status === statusFilter;
}

export function countEntriesByQueueStatus(entries: TrackerEntry[]): QueueStatusCounts {
  const counts: QueueStatusCounts = { total: entries.length };
  for (const entry of entries) {
    counts[entry.status] = (counts[entry.status] || 0) + 1;
    if (entry.status !== "pending" && isQueueLikeEntry(entry)) {
      counts.pending = (counts.pending || 0) + 1;
    }
  }
  return counts;
}
