import type { TrackerEntry } from "@/components/shared/types";
import { isTerminalNotFoundEntry } from "../../../domain/tracker-terminal-display.js";
import { resolveEntryName } from "../shared/entry-display.js";
import { resolveDaemonOperationQueueTitle } from "./operation-queue-view.js";

export type QueueSortMode = "start-newest" | "start-oldest" | "label-asc" | "label-desc";

export const DEFAULT_QUEUE_SORT_MODE: QueueSortMode = "start-newest";

export const QUEUE_SORT_STORAGE_KEY = "hr-dashboard-queue-sort-v1";

export const QUEUE_SORT_OPTIONS: { value: QueueSortMode; label: string }[] = [
  { value: "start-newest", label: "Start · newest first" },
  { value: "start-oldest", label: "Start · oldest first" },
  { value: "label-asc", label: "Name · A–Z" },
  { value: "label-desc", label: "Name · Z–A" },
];

export function isQueueSortMode(value: string): value is QueueSortMode {
  return (
    value === "start-newest" ||
    value === "start-oldest" ||
    value === "label-asc" ||
    value === "label-desc"
  );
}

/** Terminal “Not found” rows sink to the end only for name sorts — time sorts order purely by time. */
function deferTerminalNotFoundToEnd(mode: QueueSortMode): boolean {
  return mode === "label-asc" || mode === "label-desc";
}

function compareStartNewest(a: TrackerEntry, b: TrackerEntry): number {
  const aStart = a.firstLogTs ?? "";
  const bStart = b.firstLogTs ?? "";
  if (!aStart && bStart) return 1;
  if (aStart && !bStart) return -1;
  if (!aStart && !bStart) return b.timestamp.localeCompare(a.timestamp);
  return bStart.localeCompare(aStart);
}

function compareStartOldest(a: TrackerEntry, b: TrackerEntry): number {
  const aStart = a.firstLogTs ?? "";
  const bStart = b.firstLogTs ?? "";
  if (!aStart && bStart) return 1;
  if (aStart && !bStart) return -1;
  if (!aStart && !bStart) return a.timestamp.localeCompare(b.timestamp);
  return aStart.localeCompare(bStart);
}

function labelSortKey(entry: TrackerEntry, displayNames?: Map<string, string>): string {
  const name = resolveEntryName(entry, displayNames).trim();
  return name || entry.id;
}

function compareLabelAsc(
  a: TrackerEntry,
  b: TrackerEntry,
  displayNames?: Map<string, string>,
): number {
  const cmp = labelSortKey(a, displayNames).localeCompare(labelSortKey(b, displayNames), undefined, {
    sensitivity: "base",
    numeric: true,
  });
  if (cmp !== 0) return cmp;
  return a.id.localeCompare(b.id);
}

function compareLabelDesc(
  a: TrackerEntry,
  b: TrackerEntry,
  displayNames?: Map<string, string>,
): number {
  return -compareLabelAsc(a, b, displayNames);
}

function compareByMode(
  a: TrackerEntry,
  b: TrackerEntry,
  mode: QueueSortMode,
  displayNames?: Map<string, string>,
): number {
  switch (mode) {
    case "start-newest":
      return compareStartNewest(a, b);
    case "start-oldest":
      return compareStartOldest(a, b);
    case "label-asc":
      return compareLabelAsc(a, b, displayNames);
    case "label-desc":
      return compareLabelDesc(a, b, displayNames);
    default:
      return 0;
  }
}

/** Exported for daemon-batch card ordering (synthetic representatives). */
export function compareTrackerEntriesForQueueSort(
  a: TrackerEntry,
  b: TrackerEntry,
  mode: QueueSortMode,
  displayNames?: Map<string, string>,
): number {
  return compareByMode(a, b, mode, displayNames);
}

/**
 * Synthetic row so daemon batch summary cards use the same ordering rules as
 * flat queue rows. `firstLogTs` is the earliest member log anchor; `timestamp`
 * is the earliest member tracker timestamp when no logs exist yet.
 */
export function buildDaemonOperationSortRepresentative(
  operationParentRunId: string,
  members: TrackerEntry[],
  workflowLabel: string,
): TrackerEntry {
  const title = resolveDaemonOperationQueueTitle(workflowLabel, members, operationParentRunId);
  if (members.length === 0) {
    return {
      workflow: "",
      id: operationParentRunId,
      timestamp: "",
      status: "pending",
      runId: operationParentRunId,
      data: { __subject: title },
    };
  }
  const wf = members[0].workflow;
  const tsSorted = [...members].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const earliestTs = tsSorted[0].timestamp;
  const logs = members.map((m) => m.firstLogTs).filter(Boolean) as string[];
  const earliestLog = logs.length > 0 ? [...logs].sort()[0] : "";
  return {
    workflow: wf,
    id: operationParentRunId,
    timestamp: earliestTs,
    runId: operationParentRunId,
    status: "pending",
    ...(earliestLog ? { firstLogTs: earliestLog } : {}),
    data: { __subject: title },
  };
}

export function operationMembersAreAllTerminalNotFound(members: TrackerEntry[]): boolean {
  if (members.length === 0) return false;
  return members.every((m) => isTerminalNotFoundEntry(m));
}

/**
 * Order daemon-batch parent ids like flat rows: same {@link QueueSortMode}.
 * For name sorts, batches whose members are **all** terminal “Not found” sink
 * to the end; for start-time sorts, ordering is by time only.
 */
export function sortDaemonOperationParentIds(
  parentIds: readonly string[],
  membersByParent: Map<string, TrackerEntry[]>,
  mode: QueueSortMode,
  workflowLabel: string,
  displayNames?: Map<string, string>,
): string[] {
  const wrapped = parentIds.map((pid) => {
    const members = membersByParent.get(pid) ?? [];
    const rep = buildDaemonOperationSortRepresentative(pid, members, workflowLabel);
    const allNf = operationMembersAreAllTerminalNotFound(members);
    return { pid, rep, allNf };
  });
  if (!deferTerminalNotFoundToEnd(mode)) {
    return [...wrapped]
      .sort((a, b) => compareByMode(a.rep, b.rep, mode, displayNames))
      .map((w) => w.pid);
  }
  const primary = wrapped.filter((w) => !w.allNf);
  const deferred = wrapped.filter((w) => w.allNf);
  const sortBucket = (bucket: typeof wrapped) =>
    [...bucket].sort((a, b) => compareByMode(a.rep, b.rep, mode, displayNames));
  return [...sortBucket(primary), ...sortBucket(deferred)].map((w) => w.pid);
}

/**
 * Applies queue sort mode. For **name** sorts, terminal **Not found** rows
 * render after other rows, then sort within each tier. For **start time**
 * sorts, every row (including not found) orders by the active time rule only.
 */
export function sortQueueEntriesForDisplay(
  entries: TrackerEntry[],
  mode: QueueSortMode,
  displayNames?: Map<string, string>,
): TrackerEntry[] {
  if (!deferTerminalNotFoundToEnd(mode)) {
    return [...entries].sort((a, b) => compareByMode(a, b, mode, displayNames));
  }
  const terminalNotFound: TrackerEntry[] = [];
  const rest: TrackerEntry[] = [];
  for (const e of entries) {
    if (isTerminalNotFoundEntry(e)) terminalNotFound.push(e);
    else rest.push(e);
  }
  const sortBucket = (bucket: TrackerEntry[]) =>
    [...bucket].sort((a, b) => compareByMode(a, b, mode, displayNames));
  return [...sortBucket(rest), ...sortBucket(terminalNotFound)];
}

export function readStoredQueueSortMode(): QueueSortMode {
  try {
    const raw = localStorage.getItem(QUEUE_SORT_STORAGE_KEY);
    if (raw && isQueueSortMode(raw)) return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT_QUEUE_SORT_MODE;
}
