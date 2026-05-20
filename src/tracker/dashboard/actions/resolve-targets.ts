/**
 * Scope → target resolution for the central workflow action engine.
 *
 * The blast radius of an action is decided here, *before* any low-level
 * handler runs:
 *
 * - `row` / `group` / `visible-view` — use the caller-provided targets
 *   verbatim. No expansion, no surprise queries. `visible-view` in
 *   particular must never reach hidden rows, so it stays a pure passthrough.
 * - `tree` — parent rows plus their descendants, walked through the SQLite
 *   `runs.parent_run_id` chain. When the projection DB is unavailable the
 *   walk is skipped and `tree` degrades to the verbatim set (safe: never
 *   cancels/deletes more than the caller asked for).
 */
import { isStateDbReady, openStateDb } from "../../state/db.js";
import type { WorkflowActionRequest } from "./types.js";

export interface ResolvedActionTarget {
  workflow: string;
  id: string;
  runId?: string;
  date?: string;
  status?: "pending" | "running";
}

export type ResolveTargetsResult =
  | { ok: true; targets: ResolvedActionTarget[] }
  | { ok: false; error: string };

function targetKey(t: ResolvedActionTarget): string {
  return `${t.workflow}\0${t.id}\0${t.runId ?? ""}`;
}

function toResolved(
  req: WorkflowActionRequest,
  target: WorkflowActionRequest["targets"][number],
): ResolvedActionTarget {
  const date = target.date ?? req.date;
  return {
    workflow: req.workflowId,
    id: target.id,
    ...(target.runId ? { runId: target.runId } : {}),
    ...(date ? { date } : {}),
    ...(target.status ? { status: target.status } : {}),
  };
}

/** BFS over `runs.parent_run_id` to collect every descendant run. */
function collectDescendants(dir: string, rootRunIds: string[]): ResolvedActionTarget[] {
  if (rootRunIds.length === 0 || !isStateDbReady(dir)) return [];
  const db = openStateDb(dir);
  const out = new Map<string, ResolvedActionTarget>();
  const queue = [...rootRunIds];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const parentRunId = queue.shift()!;
    if (!parentRunId || seen.has(parentRunId)) continue;
    seen.add(parentRunId);
    const children = db.prepare(`
      SELECT workflow, tracker_date, item_id, run_id
      FROM runs
      WHERE parent_run_id = @parentRunId
      ORDER BY tracker_date ASC, workflow ASC, item_id ASC, run_id ASC
    `).all({ parentRunId }) as Array<{
      workflow: string;
      tracker_date: string;
      item_id: string;
      run_id: string;
    }>;
    for (const child of children) {
      const resolved: ResolvedActionTarget = {
        workflow: child.workflow,
        id: child.item_id,
        runId: child.run_id,
        date: child.tracker_date,
      };
      const key = targetKey(resolved);
      if (!out.has(key)) out.set(key, resolved);
      queue.push(child.run_id);
    }
  }
  return [...out.values()];
}

/**
 * Resolve a {@link WorkflowActionRequest} into the concrete set of rows the
 * action will touch. Pure for non-`tree` scopes; `tree` reads the SQLite
 * projection.
 */
export function resolveActionTargets(
  req: WorkflowActionRequest,
  dir: string,
): ResolveTargetsResult {
  if (req.targets.length === 0) {
    return { ok: false, error: "no targets provided" };
  }
  const base = req.targets.map((t) => toResolved(req, t));
  if (req.scope !== "tree") {
    return { ok: true, targets: base };
  }
  const merged = new Map<string, ResolvedActionTarget>();
  for (const t of base) merged.set(targetKey(t), t);
  const rootRunIds = base
    .map((t) => t.runId)
    .filter((runId): runId is string => Boolean(runId));
  for (const descendant of collectDescendants(dir, rootRunIds)) {
    const key = targetKey(descendant);
    if (!merged.has(key)) merged.set(key, descendant);
  }
  return { ok: true, targets: [...merged.values()] };
}
