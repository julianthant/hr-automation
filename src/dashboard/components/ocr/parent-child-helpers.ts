import type { TrackerEntry } from "../types.js";

export interface BatchCounts {
  done: number;
  running: number;
  queued: number;
  failed: number;
  total: number;
}

export interface PreviewChild {
  id: string;
  runId?: string;
  name: string;
  emplId?: string;
  status: TrackerEntry["status"];
}

export interface BatchElapsed {
  startMs: number;
  endMs: number;
  /** True when every child is terminal — caller should stop ticking the timer. */
  frozen: boolean;
}

export type BatchAccent = "warning" | "success" | "destructive";

/** Group children by status. `skipped` is folded into `done` (terminal success). */
export function aggregateBatchCounts(children: TrackerEntry[]): BatchCounts {
  const counts: BatchCounts = {
    done: 0,
    running: 0,
    queued: 0,
    failed: 0,
    total: children.length,
  };
  for (const c of children) {
    if (c.status === "done" || c.status === "skipped") counts.done += 1;
    else if (c.status === "running") counts.running += 1;
    else if (c.status === "pending") counts.queued += 1;
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
    name: c.data?.name || c.id,
    emplId: c.data?.emplId ?? c.data?.eid,
    status: c.status,
  }));
}

/**
 * Earliest child start ms → latest end ms. Returns null when no child has a
 * usable timestamp. `frozen=true` means every child is terminal — stop the timer.
 */
export function computeBatchElapsed(
  children: TrackerEntry[],
): BatchElapsed | null {
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
export function resolveBatchAccent(counts: BatchCounts): BatchAccent {
  if (counts.failed > 0) return "destructive";
  if (counts.total > 0 && counts.running === 0 && counts.queued === 0)
    return "success";
  return "warning";
}
