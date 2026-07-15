/**
 * Scope → target resolution for the central workflow action engine.
 *
 * The blast radius of an action is decided here, *before* any low-level
 * handler runs:
 *
 * - `row` / `group` / `visible-view` — use the caller-provided targets
 *   verbatim. No expansion, no surprise queries. `visible-view` in
 *   particular must never reach hidden rows, so it stays a pure passthrough.
 * - `tree` — parent rows plus descendants from the authoritative
 *   `tasks.parent_run_id` chain. Projection-only display rows remain eligible,
 *   but a task-backed `runs.parent_run_id` disagreement fails loud instead of
 *   silently expanding the blast radius. When SQLite is unavailable the walk
 *   is skipped and `tree` degrades to the verbatim set.
 */
import { isStateDbReady, openStateDb } from "../../tracker/state/db.js";
import { getTaskByRunId, listTaskTreeByRunIds } from "../../core/task-store/queries.js";
import { isTerminalTaskState } from "../../core/task-store/types.js";
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
    workflow: target.workflowId || req.workflowId,
    id: target.id,
    ...(target.runId ? { runId: target.runId } : {}),
    ...(date ? { date } : {}),
    ...(target.status ? { status: target.status } : {}),
  };
}

interface ProjectionDescendant {
  workflow: string;
  id: string;
  runId: string;
  parentRunId: string;
  date: string;
  latestStatus: string;
}

type DescendantResult =
  | { ok: true; targets: ResolvedActionTarget[] }
  | { ok: false; error: string };

/** Reconcile the authoritative task tree with its queue projection. */
function collectDescendants(dir: string, rootRunIds: string[]): DescendantResult {
  if (rootRunIds.length === 0 || !isStateDbReady(dir)) return { ok: true, targets: [] };
  const db = openStateDb(dir);
  const projected: ProjectionDescendant[] = [];
  const queue = [...rootRunIds];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const parentRunId = queue.shift()!;
    if (!parentRunId || seen.has(parentRunId)) continue;
    seen.add(parentRunId);
    const children = db.prepare(`
      SELECT workflow, tracker_date, item_id, run_id, parent_run_id, latest_status
      FROM runs
      WHERE parent_run_id = @parentRunId
      ORDER BY tracker_date ASC, workflow ASC, item_id ASC, run_id ASC
    `).all({ parentRunId }) as Array<{
      workflow: string;
      tracker_date: string;
      item_id: string;
      run_id: string;
      parent_run_id: string;
      latest_status: string;
    }>;
    for (const child of children) {
      queue.push(child.run_id);
      projected.push({
        workflow: child.workflow,
        id: child.item_id,
        runId: child.run_id,
        parentRunId: child.parent_run_id,
        date: child.tracker_date,
        latestStatus: child.latest_status,
      });
    }
  }

  const taskTree = listTaskTreeByRunIds(db, { rootRunIds });
  const authoritativeTaskIds = new Set(taskTree.map((task) => task.taskId));
  const projectedRunIds = new Set(projected.map((row) => row.runId));

  for (const row of projected) {
    if (row.latestStatus === "done" || row.latestStatus === "failed" || row.latestStatus === "skipped") continue;
    const task = getTaskByRunId(db, row.runId);
    if (task && !authoritativeTaskIds.has(task.taskId)) {
      return {
        ok: false,
        error:
          `tree hierarchy disagreement for run ${row.runId}: runs.parent_run_id=${row.parentRunId} ` +
          `places task ${task.taskId} under the requested root, but tasks.parent_run_id=${task.parentRunId ?? "null"} does not`,
      };
    }
  }

  const out = new Map<string, ResolvedActionTarget>();
  for (const task of taskTree) {
    if (isTerminalTaskState(task.state)) continue;
    const runId = task.currentRunId ?? task.runId;
    if (runId) {
      const projection = db.prepare(`
        SELECT parent_run_id
        FROM runs
        WHERE run_id = ?
        LIMIT 1
      `).get(runId) as { parent_run_id: string | null } | undefined;
      if (projection && !projectedRunIds.has(runId)) {
        return {
          ok: false,
          error:
            `tree hierarchy disagreement for run ${runId}: tasks.parent_run_id=${task.parentRunId ?? "null"} ` +
            `places task ${task.taskId} under the requested root, but runs.parent_run_id=${projection.parent_run_id ?? "null"} does not`,
        };
      }
    }
    const resolved: ResolvedActionTarget = {
      workflow: task.workflow,
      id: task.itemId,
      ...(runId ? { runId } : {}),
      status:
        task.state === "claimed" ||
        task.state === "running" ||
        task.state === "cancel_requested" ||
        task.state === "cancelling"
          ? "running"
          : "pending",
    };
    const key = targetKey(resolved);
    if (!out.has(key)) out.set(key, resolved);
  }

  for (const row of projected) {
    if (row.latestStatus === "done" || row.latestStatus === "failed" || row.latestStatus === "skipped") continue;
    if (getTaskByRunId(db, row.runId)) continue;
    const resolved: ResolvedActionTarget = {
      workflow: row.workflow,
      id: row.id,
      runId: row.runId,
      date: row.date,
      status: row.latestStatus === "running" ? "running" : "pending",
    };
    out.set(targetKey(resolved), resolved);
  }
  return { ok: true, targets: [...out.values()] };
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
  if (!req.treeExcludeRoots) {
    for (const t of base) merged.set(targetKey(t), t);
  }
  const rootRunIds = base
    .map((t) => t.runId)
    .filter((runId): runId is string => Boolean(runId));
  const descendants = collectDescendants(dir, rootRunIds);
  if (!descendants.ok) return descendants;
  for (const descendant of descendants.targets) {
    const key = targetKey(descendant);
    if (!merged.has(key)) merged.set(key, descendant);
  }
  return { ok: true, targets: [...merged.values()] };
}
