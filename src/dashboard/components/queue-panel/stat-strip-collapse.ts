import type { TrackerEntry } from "@/components/shared/types";
import { isApprovedPrepRow, isDiscardedPrepRow } from "@/components/ocr/types";

import { isQueueLikeEntry } from "./queue-status";

/**
 * One representative entry per daemon/delegation **batch**, sized for
 * {@link collapseEntriesForStatStrip} / StatPills. Status is mutually
 * exclusive in the rollup sense (queued → active → failed → done).
 */
function rollupBatchMembersToStatSynth(
  parentRunId: string,
  members: readonly TrackerEntry[],
): TrackerEntry {
  const wf = members[0]?.workflow ?? "";
  const ts = members[0]?.timestamp ?? new Date().toISOString();

  let status: TrackerEntry["status"];
  if (members.some((m) => isQueueLikeEntry(m))) {
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
    id: `__dash-stat-batch:${parentRunId}`,
    runId: parentRunId,
    timestamp: ts,
    status,
    data: {},
  };
}

/**
 * Reduces SSE-style tracker rows into one unit per visible queue surface row:
 * batch members grouped by {@link TrackerEntry.parentRunId} count once; plain
 * primaries unchanged. Mirrors how {@link DaemonBatchRow} folds children.
 *
 * OCR approved-prep anchors are omitted when present (delegation summaries are
 * the batch card; children carry `parentRunId`).
 */
export function collapseEntriesForStatStrip(entries: readonly TrackerEntry[]): TrackerEntry[] {
  const visible = entries.filter((e) => !isDiscardedPrepRow(e));

  const batchMembersByParent = new Map<string, TrackerEntry[]>();
  for (const e of visible) {
    if (!e.parentRunId) continue;
    const list = batchMembersByParent.get(e.parentRunId) ?? [];
    list.push(e);
    batchMembersByParent.set(e.parentRunId, list);
  }

  const synthBatches: TrackerEntry[] = [];
  for (const [parentRunId, members] of batchMembersByParent) {
    synthBatches.push(rollupBatchMembersToStatSynth(parentRunId, members));
  }

  const standalone: TrackerEntry[] = [];
  for (const e of visible) {
    if (e.parentRunId && batchMembersByParent.has(e.parentRunId)) continue;
    if (isApprovedPrepRow(e)) continue;
    standalone.push(e);
  }

  return [...standalone, ...synthBatches];
}
