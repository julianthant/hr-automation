/**
 * Low-level delete operations (single entry / bulk / delegated-children).
 *
 * The primitive behind the central action engine — operator deletes arrive
 * through `actions/perform-workflow-action.ts`, which decides scope and
 * routes here. `deleteDelegatedChildrenForRun` stays exported for the OCR
 * discard path.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { openStateDb } from "../../tracker/state/db.js";
import { transaction } from "../../infra/sqlite/index.js";
import { listTaskTreeByRunIds } from "../../core/task-store/queries.js";
import { persistDeletionManifest } from "../../tracker/deletions/store.js";
import {
  rowFilePath,
  rowsDir,
  parseWorkflowDateFilename,
} from "../../tracker/paths.js";

export interface DeleteEntryRequest {
  workflow: string;
  id: string;
  date: string;
  runId?: string;
}

export type DeleteEntryResult =
  | { ok: true }
  | { ok: false; error: string; status?: number };

export interface DeleteBulkRequest {
  workflow: string;
  date: string;
  ids?: string[];
  items?: Array<{ id: string; runId?: string }>;
}

export type DeleteBulkResult =
  | { ok: true; count: number; errors: Array<{ id: string; error: string }> }
  | { ok: false; count: 0; errors: Array<{ id: string; error: string }> };

export interface DeleteEntryOptions {
  screenshotsDir?: string;
}

/**
 * Durably hide tracker runs through one append-only deletion manifest.
 * Source JSONL and terminal execution/audit records remain intact.
 */
function applyDeleteTargets(
  db: ReturnType<typeof openStateDb>,
  dir: string,
  targets: DeleteTarget[],
): DeleteEntryResult {
  const dbResult = transaction(db, () => {
    const exactTargets = normalizeDeleteTargets(db, dir, targets);
    const taskIds = collectTaskSubtreeIds(db, exactTargets);
    const active = findActiveTaskForDelete(db, taskIds);
    if (active) {
      return {
        ok: false as const,
        status: 409,
        error: `cannot delete active task ${active.workflow}/${active.itemId} in state ${active.state}`,
      };
    }
    persistDeletionManifest(
      db,
      dir,
      exactTargets.map((target) => ({
        workflow: target.workflow,
        trackerDate: target.date,
        itemId: target.id,
        runId: target.runId,
      })),
      "operator-delete",
    );
    return { ok: true as const };
  });
  return dbResult;
}

export function buildDeleteEntryHandler(dir: string, opts: DeleteEntryOptions = {}) {
  void opts;
  return function deleteEntry(req: DeleteEntryRequest): DeleteEntryResult {
    const { workflow, id, date } = req;
    if (!workflow || !id || !date) {
      return { ok: false, error: "workflow, id, date are required", status: 400 };
    }
    const db = openStateDb(dir);
    const targets = collectDeleteTargets(db, dir, req);
    return applyDeleteTargets(db, dir, targets);
  };
}

/**
 * Bulk delete helper. HTTP `/api/delete-bulk` routes through
 * `performWorkflowAction`; this factory remains for unit tests.
 */
export function buildDeleteBulkHandler(dir: string, opts: DeleteEntryOptions = {}) {
  void opts;
  return (req: DeleteBulkRequest): DeleteBulkResult => {
    const errors: Array<{ id: string; error: string }> = [];
    const items: Array<{ id: string; runId?: string }> = req.items && req.items.length > 0
      ? req.items
      : (req.ids ?? []).map((id) => ({ id }));
    if (!req.workflow || !req.date) {
      return {
        ok: false,
        count: 0,
        errors: [{ id: "", error: "workflow and date are required" }],
      };
    }
    if (items.length === 0) {
      return { ok: true, count: 0, errors: [] };
    }

    const db = openStateDb(dir);
    const requests: DeleteEntryRequest[] = [];
    let count = 0;
    for (const item of items) {
      if (!item.id) {
        errors.push({ id: item.id ?? "", error: "id is required" });
        continue;
      }
      count++;
      requests.push({
        workflow: req.workflow,
        id: item.id,
        date: req.date,
        ...(item.runId ? { runId: item.runId } : {}),
      });
    }

    if (requests.length === 0) {
      return { ok: true, count: 0, errors };
    }

    const allTargets = collectDeleteTargetsBulk(db, dir, requests);
    const applied = applyDeleteTargets(db, dir, allTargets);
    if (!applied.ok) {
      return { ok: false, count: 0, errors: requests.map((request) => ({ id: request.id, error: applied.error })) };
    }
    return { ok: true, count, errors };
  };
}

export function deleteDelegatedChildrenForRun(
  dir: string,
  parentRunId: string,
  opts: DeleteEntryOptions = {},
): void {
  if (!parentRunId) return;
  const db = openStateDb(dir);
  const targets = collectDescendantDeleteTargets(db, dir, [parentRunId]);
  if (targets.length === 0) return;
  void opts;
  const result = applyDeleteTargets(db, dir, targets);
  if (!result.ok) throw new Error(result.error);
}

type DeleteTarget = DeleteEntryRequest;
type ExactDeleteTarget = DeleteTarget & { runId: string };

function collectDeleteTargetsBulk(
  db: ReturnType<typeof openStateDb>,
  dir: string,
  requests: DeleteEntryRequest[],
): DeleteTarget[] {
  const merged = new Map<string, DeleteTarget>();
  for (const req of requests) {
    for (const t of collectDeleteTargets(db, dir, req)) {
      merged.set(deleteTargetKey(t), t);
    }
  }
  return [...merged.values()];
}

function collectDeleteTargets(
  db: ReturnType<typeof openStateDb>,
  dir: string,
  req: DeleteEntryRequest,
): DeleteTarget[] {
  const targets = new Map<string, DeleteTarget>();
  const add = (target: DeleteTarget) => {
    targets.set(deleteTargetKey(target), target);
  };
  add(req);

  const queue = collectRootRunIds(db, dir, req);
  for (const target of collectDescendantDeleteTargets(db, dir, queue)) {
    add(target);
  }
  return [...targets.values()];
}

/** Expand an item-scoped request to the exact runs that exist now. */
function normalizeDeleteTargets(
  db: ReturnType<typeof openStateDb>,
  dir: string,
  targets: DeleteTarget[],
): ExactDeleteTarget[] {
  const exact = new Map<string, ExactDeleteTarget>();
  for (const target of targets) {
    const runIds = target.runId ? [target.runId] : collectRootRunIds(db, dir, target);
    for (const runId of runIds) {
      const normalized = { ...target, runId };
      exact.set(deleteTargetKey(normalized), normalized);
    }
  }
  return [...exact.values()];
}

function collectDescendantDeleteTargets(
  db: ReturnType<typeof openStateDb>,
  dir: string,
  rootRunIds: string[],
): DeleteTarget[] {
  const targets = new Map<string, DeleteTarget>();
  const add = (target: DeleteTarget) => {
    targets.set(deleteTargetKey(target), target);
  };
  const queue = [...rootRunIds];
  const seenRunIds = new Set<string>();
  while (queue.length > 0) {
    const parentRunId = queue.shift()!;
    if (!parentRunId || seenRunIds.has(parentRunId)) continue;
    seenRunIds.add(parentRunId);
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
      add({
        workflow: child.workflow,
        id: child.item_id,
        date: child.tracker_date,
        runId: child.run_id,
      });
      queue.push(child.run_id);
    }
    for (const child of readJsonlChildrenForParent(dir, parentRunId)) {
      add(child);
      if (child.runId) queue.push(child.runId);
    }
  }
  return [...targets.values()];
}

function collectRootRunIds(db: ReturnType<typeof openStateDb>, dir: string, req: DeleteEntryRequest): string[] {
  if (req.runId) return [req.runId];
  const rows = db.prepare(`
    SELECT run_id
    FROM runs
    WHERE workflow = @workflow AND tracker_date = @date AND item_id = @id
    ORDER BY run_ordinal ASC
  `).all(req) as Array<{ run_id: string }>;
  const runIds = new Set(rows.map((row) => row.run_id));
  const taskRows = db.prepare(`
    SELECT run_id
    FROM tasks
    WHERE workflow = @workflow AND item_id = @id AND run_id IS NOT NULL
  `).all(req) as Array<{ run_id: string }>;
  taskRows.forEach((row) => runIds.add(row.run_id));
  const path = rowFilePath(req.workflow, req.date, dir);
  if (existsSync(path)) {
    for (const row of readCompleteJsonlObjects(path)) {
      if (row.id === req.id) {
        runIds.add(typeof row.runId === "string" ? row.runId : `${req.id}#1`);
      }
    }
  }
  return [...runIds];
}

function readJsonlChildrenForParent(dir: string, parentRunId: string): DeleteTarget[] {
  const targets: DeleteTarget[] = [];
  const rows = rowsDir(dir);
  let names: string[];
  try {
    names = readdirSync(rows);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return targets;
    throw error;
  }
  for (const name of names) {
    const parsed = parseWorkflowDateFilename(name);
    if (!parsed) continue;
    const { workflow, date } = parsed;
    const path = rowFilePath(workflow, date, dir);
    for (const row of readCompleteJsonlObjects(path)) {
      if (typeof row.id !== "string" || row.parentRunId !== parentRunId) continue;
      if (typeof row.runId !== "string") continue;
      targets.push({
        workflow,
        date,
        id: row.id,
        runId: row.runId,
      });
    }
  }
  return targets;
}

function readCompleteJsonlObjects(path: string): Array<Record<string, unknown>> {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const newlineTerminated = raw.endsWith("\n");
  const out: Array<Record<string, unknown>> = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("JSONL row is not an object");
      }
      out.push(value as Record<string, unknown>);
    } catch (error) {
      const incompleteFinalTail = !newlineTerminated && index === lines.length - 1;
      if (incompleteFinalTail) break;
      throw new Error(`Malformed tracker JSONL at ${path}:${index + 1}`, { cause: error });
    }
  }
  return out;
}

function deleteTargetKey(target: DeleteTarget): string {
  return `${target.workflow}\0${target.date}\0${target.id}\0${target.runId ?? ""}`;
}

function collectTaskSubtreeIds(db: ReturnType<typeof openStateDb>, targets: DeleteTarget[]): string[] {
  const rootTaskIds = new Set<string>();
  const rootRunIds = new Set<string>();
  for (const target of targets) {
    if (target.runId) {
      rootRunIds.add(target.runId);
      const rows = db.prepare(`
        SELECT id
        FROM tasks
        WHERE workflow = @workflow AND item_id = @id AND run_id = @runId
      `).all(target) as Array<{ id: string }>;
      rows.forEach((row) => rootTaskIds.add(row.id));
    } else {
      const rows = db.prepare(`
        SELECT id
        FROM tasks
        WHERE workflow = @workflow AND item_id = @id
      `).all(target) as Array<{ id: string }>;
      rows.forEach((row) => rootTaskIds.add(row.id));
    }
  }
  for (const task of listTaskTreeByRunIds(db, { rootRunIds: [...rootRunIds] })) {
    rootTaskIds.add(task.taskId);
  }
  if (rootTaskIds.size === 0) return [];

  const allTaskIds = new Set(rootTaskIds);
  const queue = [...rootTaskIds];
  while (queue.length > 0) {
    const parentTaskId = queue.shift()!;
    const children = db.prepare(`
      SELECT child_task_id
      FROM task_dependencies
      WHERE parent_task_id = ?
    `).all(parentTaskId) as Array<{ child_task_id: string }>;
    for (const child of children) {
      if (allTaskIds.has(child.child_task_id)) continue;
      allTaskIds.add(child.child_task_id);
      queue.push(child.child_task_id);
    }
  }

  return [...allTaskIds];
}

function findActiveTaskForDelete(
  db: ReturnType<typeof openStateDb>,
  taskIds: string[],
): { workflow: string; itemId: string; state: string } | null {
  if (taskIds.length === 0) return null;
  const placeholders = taskIds.map(() => "?").join(",");
  const row = db.prepare(`
    SELECT workflow, item_id, control_state
    FROM tasks
    WHERE id IN (${placeholders})
      AND (control_state IS NULL OR control_state NOT IN ('done', 'failed', 'cancelled'))
    ORDER BY COALESCE(enqueued_at, created_at) ASC, id ASC
    LIMIT 1
  `).get(...taskIds) as { workflow: string; item_id: string; control_state: string | null } | undefined;
  return row
    ? {
        workflow: row.workflow,
        itemId: row.item_id,
        state: row.control_state === null ? "invalid-null" : row.control_state,
      }
    : null;
}
