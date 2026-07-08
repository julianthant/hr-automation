import type { TrackerEntry } from "@/components/shared/types.js";
import { useElapsed, formatDuration } from "@/components/hooks/useElapsed";
import { statusKeyForEntry } from "@/components/shared/status-styles.js";
import { resolvePersonNameFromData } from "../../../domain/queue-row-presentation.js";

export interface OperationCounts {
  done: number;
  running: number;
  queued: number;
  failed: number;
  cancelled: number;
  total: number;
}

export interface PreviewChild {
  id: string;
  runId?: string;
  name: string;
  emplId?: string;
  status: TrackerEntry["status"];
}

export interface OperationElapsed {
  startMs: number;
  endMs: number;
  /** True when every child is terminal — caller should stop ticking the timer. */
  frozen: boolean;
}

export type OperationAccent = "warning" | "success" | "destructive";

/**
 * Collapse retry attempts to one entry per item — the latest run. A retried
 * member is a NEW run (new `runId`, `runOrdinal` + 1) under the SAME item `id`
 * (retry replays the original input, so the item id is stable; `runOrdinal` is
 * the per-item run number). Counting both attempts double-counts the operation
 * header (ISS-003: a 4-signer doc with one retried member read "6"). This dedup
 * affects the COUNT only — the member LIST still renders every attempt, so the
 * failed-original and the done-retry stay visible in history.
 */
export function dedupeMembersByLatestRun(children: TrackerEntry[]): TrackerEntry[] {
  const latestById = new Map<string, TrackerEntry>();
  for (const c of children) {
    const prev = latestById.get(c.id);
    if (!prev || isLaterRun(c, prev)) latestById.set(c.id, c);
  }
  return [...latestById.values()];
}

function isLaterRun(a: TrackerEntry, b: TrackerEntry): boolean {
  const ao = a.runOrdinal ?? 0;
  const bo = b.runOrdinal ?? 0;
  if (ao !== bo) return ao > bo;
  const at = a.firstLogTs ?? a.timestamp ?? "";
  const bt = b.firstLogTs ?? b.timestamp ?? "";
  return at > bt;
}

/**
 * Group children by status. `skipped` is folded into `done` (terminal success).
 * A cancelled member (`failed` + `step === "cancelled"`) lands in `cancelled`,
 * consistent with `statusKeyForEntry` and the per-member chip (E2E-103).
 * Retry attempts collapse to the latest run per item (`dedupeMembersByLatestRun`)
 * so a retried member counts once (ISS-003).
 */
export function aggregateOperationCounts(children: TrackerEntry[]): OperationCounts {
  const deduped = dedupeMembersByLatestRun(children);
  const counts: OperationCounts = {
    done: 0,
    running: 0,
    queued: 0,
    failed: 0,
    cancelled: 0,
    total: deduped.length,
  };
  for (const c of deduped) {
    if (c.status === "done" || c.status === "skipped") counts.done += 1;
    else if (c.status === "running") counts.running += 1;
    else if (c.status === "pending") counts.queued += 1;
    else if (statusKeyForEntry(c) === "cancelled") counts.cancelled += 1;
    else if (c.status === "failed") counts.failed += 1;
  }
  return counts;
}

const STATUS_ORDER: Record<string, number> = {
  running: 0,
  pending: 1,
  done: 2,
  skipped: 2,
  failed: 3,
};

/** Pick the first n children sorted by (running > queued > done > failed), tiebreak firstLogTs desc. */
export function pickPreviewChildren(
  children: TrackerEntry[],
  n: number,
): PreviewChild[] {
  const sorted = [...children].sort((a, b) => {
    const orderDelta =
      (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
    if (orderDelta !== 0) return orderDelta;
    const aTs = a.firstLogTs ?? a.timestamp ?? "";
    const bTs = b.firstLogTs ?? b.timestamp ?? "";
    if (aTs === bTs) return 0;
    return aTs < bTs ? 1 : -1;
  });
  return sorted.slice(0, n).map((c) => ({
    id: c.id,
    runId: c.runId,
    name: resolveChildLabel(c),
    emplId: validEmployeeId(c.data?.emplId) || validEmployeeId(c.data?.eid) || undefined,
    status: c.status,
  }));
}

function validEmployeeId(value: string | undefined): string {
  const normalized = (value ?? "").replace(/\D+/g, "");
  return /^10\d{6}$/.test(normalized) ? normalized : "";
}

export function resolveChildLabel(child: TrackerEntry): string {
  const data = child.data ?? {};
  const named = resolvePersonNameFromData(data);
  if (named.length > 0) return named;
  const eid = validEmployeeId(data.emplId) || validEmployeeId(data.eid);
  if (eid) return eid;
  const subject = typeof data.__subject === "string" ? data.__subject.trim() : "";
  if (subject.length > 0) return subject;
  const fallbackName = typeof data.__name === "string" ? data.__name.trim() : "";
  return fallbackName || child.id;
}

/**
 * Earliest child start ms → latest end ms. Returns null when no child has a
 * usable timestamp. `frozen=true` means every child is terminal — stop the timer.
 */
export function computeOperationElapsed(
  children: TrackerEntry[],
): OperationElapsed | null {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = 0;
  let any = false;
  let allTerminal = children.length > 0;
  for (const c of children) {
    const startSrc = c.firstLogTs ?? c.timestamp;
    const endSrc = c.lastLogTs ?? c.timestamp;
    if (startSrc) {
      const t = Date.parse(startSrc);
      if (Number.isFinite(t)) {
        startMs = Math.min(startMs, t);
        any = true;
      }
    }
    if (endSrc) {
      const t = Date.parse(endSrc);
      if (Number.isFinite(t)) endMs = Math.max(endMs, t);
    }
    if (
      c.status !== "done" &&
      c.status !== "failed" &&
      c.status !== "skipped"
    ) {
      allTerminal = false;
    }
  }
  if (!any) return null;
  return { startMs, endMs, frozen: allTerminal };
}

/** Color the 3px left accent stripe by overall batch state. */
export function resolveOperationAccent(counts: OperationCounts): OperationAccent {
  if (counts.failed > 0) return "destructive";
  // Cancelled members are amber (operator action, not a system failure). A batch
  // with only cancelled + done members reads as complete-but-partial, not failed.
  if (counts.total > 0 && counts.running === 0 && counts.queued === 0)
    return "success";
  return "warning";
}

/**
 * The batch elapsed/duration label for a `computeOperationElapsed` result: a live
 * ticking elapsed while any child is in flight, frozen to a fixed duration once
 * every child is terminal, and empty when there's no usable timestamp. Shared by
 * the operation row (`operation-row-variants`) and the delegation group row
 * (`group-row-base`) — previously byte-identical copies in each.
 */
export function useOperationElapsedLabel(elapsed: OperationElapsed | null): string {
  const liveTick = useElapsed(
    elapsed && !elapsed.frozen ? new Date(elapsed.startMs).toISOString() : null,
  );
  if (!elapsed) return "";
  if (elapsed.frozen) {
    return formatDuration(
      new Date(elapsed.startMs).toISOString(),
      new Date(elapsed.endMs).toISOString(),
    );
  }
  return liveTick;
}
