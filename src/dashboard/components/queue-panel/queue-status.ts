import type { TrackerEntry } from "@/components/shared/types";
import { isOcrAwaitingApprovalEntry } from "../../../tracker/dashboard/prep-rows.js";

export type QueueStatusCounts = Record<string, number>;

export function isAuthRunningEntry(entry: TrackerEntry): boolean {
  return entry.status === "running" && Boolean(entry.step?.startsWith("auth:"));
}

export function isQueueLikeEntry(entry: TrackerEntry): boolean {
  return entry.status === "pending" || entry.status === "skipped" || isAuthRunningEntry(entry);
}

/**
 * Under the new approval contract (2026-05-25) the OCR `awaiting-approval`
 * row carries `status="running"`, so `entry.status === "running"` already
 * pulls it into the "Active" pill bucket. The legacy `isOcrAwaitingApprovalEntry`
 * branches below remain as belt-and-suspenders — they still match the new
 * shape (running + awaiting-approval) and were previously needed for the
 * old `status="done" step="awaiting-approval"` shape that the orchestrator
 * no longer emits.
 */
export function entryMatchesStatusFilter(entry: TrackerEntry, statusFilter: string | null): boolean {
  if (!statusFilter) return true;
  if (statusFilter === "pending") return isQueueLikeEntry(entry);
  if (statusFilter === "running") {
    return entry.status === "running" || isOcrAwaitingApprovalEntry(entry);
  }
  if (statusFilter === "done") {
    return entry.status === "done" && !isOcrAwaitingApprovalEntry(entry);
  }
  return entry.status === statusFilter;
}

/**
 * Whether a queue “group” row (delegation parent + members, or daemon batch
 * members-only) should remain visible under the StatPills filter. Matches if
 * {@link entryMatchesStatusFilter} holds for the optional anchor (OCR prep
 * parent) or for any member row.
 */
export function queueGroupMatchesStatusFilter(
  statusFilter: string | null,
  members: readonly TrackerEntry[],
  anchorEntry?: TrackerEntry,
): boolean {
  if (!statusFilter) return true;
  if (anchorEntry && entryMatchesStatusFilter(anchorEntry, statusFilter)) return true;
  return members.some((m) => entryMatchesStatusFilter(m, statusFilter));
}

export function countEntriesByQueueStatus(entries: TrackerEntry[]): QueueStatusCounts {
  const counts: QueueStatusCounts = { total: entries.length };
  for (const entry of entries) {
    if (isOcrAwaitingApprovalEntry(entry)) {
      counts.running = (counts.running || 0) + 1;
      continue;
    }
    counts[entry.status] = (counts[entry.status] || 0) + 1;
    if (entry.status !== "pending" && isQueueLikeEntry(entry)) {
      counts.pending = (counts.pending || 0) + 1;
    }
  }
  return counts;
}
