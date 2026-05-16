import { existsSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { basename, join, resolve, sep } from "path";
import { PATHS } from "../../../config.js";
import { readSessionEvents } from "../../session-events.js";
import { openStateDb } from "../../state/db.js";
import { transaction } from "../../../infra/sqlite/index.js";
import { rewriteJsonlFile } from "../../jsonl-rewrite.js";

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
 * Hard-delete JSONL rows and SQLite records for a tracker entry.
 *
 * Without `runId`, this removes the entire queue item. With `runId`, this
 * removes only that run while preserving other attempts for the same item.
 * The parse cache in jsonl.ts invalidates on next read because the file's
 * mtime changes after the rewrite.
 */
function applyDeleteTargets(
  db: ReturnType<typeof openStateDb>,
  dir: string,
  targets: DeleteTarget[],
  screenshotsDir: string,
): void {
  const byFile = groupDeleteTargetsByFile(targets);
  for (const [fileKey, fileTargets] of byFile) {
    const [targetWorkflow, targetDate] = fileKey.split("\0") as [string, string];
    rewriteJsonlFile(join(dir, `${targetWorkflow}-${targetDate}.jsonl`), (row) => {
      return !matchesAnyDeleteTarget(asString(row.id), asString(row.runId), fileTargets);
    });

    rewriteJsonlFile(join(dir, `${targetWorkflow}-${targetDate}-logs.jsonl`), (row) => {
      return !matchesAnyDeleteTarget(asString(row.itemId), asString(row.runId), fileTargets);
    });
  }

  for (const target of targets) {
    deleteScreenshotsForEntry(db, dir, target, screenshotsDir);
  }
  transaction(db, () => {
    deleteTaskSubtrees(db, targets);
    for (const target of targets) {
      deleteProjectedEntry(db, target);
    }
  });
}

export function buildDeleteEntryHandler(dir: string, opts: DeleteEntryOptions = {}) {
  const screenshotsDir = opts.screenshotsDir ?? PATHS.screenshotDir;
  return function deleteEntry(req: DeleteEntryRequest): DeleteEntryResult {
    const { workflow, id, date } = req;
    if (!workflow || !id || !date) {
      return { ok: false, error: "workflow, id, date are required", status: 400 };
    }
    const db = openStateDb(dir);
    const targets = collectDeleteTargets(db, dir, req);
    applyDeleteTargets(db, dir, targets, screenshotsDir);
    return { ok: true };
  };
}

export function buildDeleteBulkHandler(dir: string, opts: DeleteEntryOptions = {}) {
  const screenshotsDir = opts.screenshotsDir ?? PATHS.screenshotDir;
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
    applyDeleteTargets(db, dir, allTargets, screenshotsDir);
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
  applyDeleteTargets(db, dir, targets, opts.screenshotsDir ?? PATHS.screenshotDir);
}

type DeleteTarget = DeleteEntryRequest;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

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
  const path = join(dir, `${req.workflow}-${req.date}.jsonl`);
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf-8").split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line) as { id?: string; runId?: string };
        if (row.id === req.id && row.runId) runIds.add(row.runId);
      } catch {
        // Ignore malformed audit lines; deletion should still proceed.
      }
    }
  }
  return [...runIds];
}

function readJsonlChildrenForParent(dir: string, parentRunId: string): DeleteTarget[] {
  const targets: DeleteTarget[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return targets;
  }
  for (const name of names) {
    const match = /^(.+)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!match || name.endsWith("-logs.jsonl")) continue;
    const [, workflow, date] = match;
    const path = join(dir, name);
    for (const line of readFileSync(path, "utf-8").split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line) as { id?: string; runId?: string; parentRunId?: string };
        if (!row.id || row.parentRunId !== parentRunId) continue;
        if (!row.runId) continue;
        targets.push({
          workflow,
          date,
          id: row.id,
          runId: row.runId,
        });
      } catch {
        // Ignore malformed audit lines; deletion should still proceed.
      }
    }
  }
  return targets;
}

function deleteTargetKey(target: DeleteTarget): string {
  return `${target.workflow}\0${target.date}\0${target.id}\0${target.runId ?? ""}`;
}

function groupDeleteTargetsByFile(targets: DeleteTarget[]): Map<string, DeleteTarget[]> {
  const grouped = new Map<string, DeleteTarget[]>();
  for (const target of targets) {
    const key = `${target.workflow}\0${target.date}`;
    const list = grouped.get(key) ?? [];
    list.push(target);
    grouped.set(key, list);
  }
  return grouped;
}

function matchesAnyDeleteTarget(
  itemId: string | undefined,
  runId: string | undefined,
  targets: DeleteTarget[],
): boolean {
  if (!itemId) return false;
  return targets.some((target) => {
    if (itemId !== target.id) return false;
    if (target.runId) {
      return runId !== undefined && runId === target.runId;
    }
    return true;
  });
}

function deleteTaskSubtrees(db: ReturnType<typeof openStateDb>, targets: DeleteTarget[]): void {
  const rootTaskIds = new Set<string>();
  for (const target of targets) {
    if (target.runId) {
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
  if (rootTaskIds.size === 0) return;

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

  const ids = [...allTaskIds];
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`
    DELETE FROM task_dependencies
    WHERE parent_task_id IN (${placeholders})
       OR child_task_id IN (${placeholders})
  `).run(...ids, ...ids);
  db.prepare(`DELETE FROM task_attempts WHERE task_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...ids);
}

function deleteProjectedEntry(db: ReturnType<typeof openStateDb>, req: DeleteTarget): void {
  const params = { workflow: req.workflow, date: req.date, id: req.id, runId: req.runId ?? "" };
  const runClause = req.runId ? " AND run_id = @runId" : "";
  db.prepare(
    `DELETE FROM run_events WHERE workflow = @workflow AND tracker_date = @date AND item_id = @id${runClause}`,
  ).run(params);
  db.prepare(
    `DELETE FROM logs WHERE workflow = @workflow AND tracker_date = @date AND item_id = @id${runClause}`,
  ).run(params);
  db.prepare(
    `DELETE FROM runs WHERE workflow = @workflow AND tracker_date = @date AND item_id = @id${runClause}`,
  ).run(params);
  db.prepare(
    `DELETE FROM files WHERE kind = 'screenshot' AND workflow = @workflow AND item_id = @id${runClause}`,
  ).run(params);
  if (!req.runId) {
    db.prepare("DELETE FROM items WHERE workflow = @workflow AND tracker_date = @date AND item_id = @id").run(params);
    return;
  }

  db.prepare(`
    WITH ordered AS (
      SELECT
        run_id,
        ROW_NUMBER() OVER (
          ORDER BY COALESCE(first_work_ts, first_any_ts), run_id
        ) AS ordinal
      FROM runs
      WHERE workflow = @workflow AND tracker_date = @date AND item_id = @id
    )
    UPDATE runs
    SET run_ordinal = (
      SELECT ordinal FROM ordered WHERE ordered.run_id = runs.run_id
    )
    WHERE workflow = @workflow AND tracker_date = @date AND item_id = @id
      AND EXISTS (SELECT 1 FROM ordered WHERE ordered.run_id = runs.run_id)
  `).run(params);

  const latestRun = db.prepare(`
    SELECT run_id, latest_status, latest_step, latest_tracker_ts, latest_data_json, latest_error
    FROM runs
    WHERE workflow = @workflow AND tracker_date = @date AND item_id = @id
    ORDER BY run_ordinal DESC
    LIMIT 1
  `).get(params) as {
    run_id: string;
    latest_status: string;
    latest_step: string | null;
    latest_tracker_ts: string;
    latest_data_json: string | null;
    latest_error: string | null;
  } | undefined;

  if (!latestRun) {
    db.prepare("DELETE FROM items WHERE workflow = @workflow AND tracker_date = @date AND item_id = @id").run(params);
    return;
  }

  db.prepare(`
    UPDATE items
    SET latest_run_id = @latestRunId,
        latest_status = @latestStatus,
        latest_step = @latestStep,
        latest_ts = @latestTs,
        latest_data_json = @latestDataJson,
        latest_error = @latestError,
        updated_at = @updatedAt
    WHERE workflow = @workflow AND tracker_date = @date AND item_id = @id
  `).run({
    ...params,
    latestRunId: latestRun.run_id,
    latestStatus: latestRun.latest_status,
    latestStep: latestRun.latest_step,
    latestTs: latestRun.latest_tracker_ts,
    latestDataJson: latestRun.latest_data_json,
    latestError: latestRun.latest_error,
    updatedAt: new Date().toISOString(),
  });
}

function deleteScreenshotsForEntry(
  db: ReturnType<typeof openStateDb>,
  dir: string,
  req: DeleteEntryRequest,
  screenshotsDir: string,
): void {
  const prefix = `${req.workflow}-${req.id}-`;
  const filenames = new Set<string>();

  if (req.runId) {
    for (const ev of readSessionEvents(dir)) {
      if (ev.type !== "screenshot" || ev.runId !== req.runId) continue;
      for (const file of (ev as { files?: Array<{ path?: string }> }).files ?? []) {
        const name = basename(file.path ?? "");
        if (name.startsWith(prefix) && name.endsWith(".png")) filenames.add(name);
      }
    }

    const rows = db.prepare(
      "SELECT storage_path FROM files WHERE kind = 'screenshot' AND workflow = @workflow AND item_id = @id AND run_id = @runId",
    ).all({ workflow: req.workflow, id: req.id, runId: req.runId }) as Array<{ storage_path: string }>;
    for (const row of rows) {
      const name = basename(row.storage_path);
      if (name.startsWith(prefix) && name.endsWith(".png")) filenames.add(name);
    }
  } else {
    try {
      for (const name of readdirSync(screenshotsDir)) {
        if (name.startsWith(prefix) && name.endsWith(".png")) filenames.add(name);
      }
    } catch {
      return;
    }
  }

  const rootAbs = resolve(screenshotsDir);
  for (const name of filenames) {
    const full = resolve(screenshotsDir, name);
    if (!full.startsWith(rootAbs + sep) && full !== rootAbs) continue;
    try {
      unlinkSync(full);
    } catch {
      // Best-effort: deleting a run must not fail because a screenshot is gone.
    }
  }
}
