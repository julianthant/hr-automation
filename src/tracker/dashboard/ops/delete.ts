import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { basename, join, resolve, sep } from "path";
import { PATHS } from "../../../config.js";
import { readSessionEvents } from "../../session-events.js";
import { openStateDb } from "../../state/db.js";
import { transaction } from "../../../infra/sqlite/index.js";

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
export function buildDeleteEntryHandler(dir: string, opts: DeleteEntryOptions = {}) {
  return function deleteEntry(req: DeleteEntryRequest): DeleteEntryResult {
    const { workflow, id, date, runId } = req;
    if (!workflow || !id || !date) {
      return { ok: false, error: "workflow, id, date are required", status: 400 };
    }

    const rewriteJsonl = (path: string, keep: (line: string) => boolean) => {
      if (!existsSync(path)) return;
      const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean).filter(keep);
      writeFileSync(path, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf-8");
    };

    rewriteJsonl(join(dir, `${workflow}-${date}.jsonl`), (line) => {
      try {
        const row = JSON.parse(line) as { id?: string; runId?: string };
        if (row.id !== id) return true;
        const rowRunId = row.runId ?? `${row.id}#1`;
        return runId ? rowRunId !== runId : false;
      } catch {
        return true;
      }
    });

    rewriteJsonl(join(dir, `${workflow}-${date}-logs.jsonl`), (line) => {
      try {
        const row = JSON.parse(line) as { itemId?: string; runId?: string };
        if (row.itemId !== id) return true;
        const rowRunId = row.runId ?? `${row.itemId}#1`;
        return runId ? rowRunId !== runId : false;
      } catch {
        return true;
      }
    });

    const db = openStateDb(dir);
    deleteScreenshotsForEntry(db, dir, req, opts.screenshotsDir ?? PATHS.screenshotDir);
    transaction(db, () => {
      const params = { workflow, date, id, runId: runId ?? "" };
      const runClause = runId ? " AND run_id = @runId" : "";
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
      if (!runId) {
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
    });

    return { ok: true };
  };
}

export function buildDeleteBulkHandler(dir: string, opts: DeleteEntryOptions = {}) {
  const del = buildDeleteEntryHandler(dir, opts);
  return (
    req: DeleteBulkRequest,
  ): {
    ok: true;
    count: number;
    errors: Array<{ id: string; error: string }>;
  } => {
    const errors: Array<{ id: string; error: string }> = [];
    let count = 0;
    const items: Array<{ id: string; runId?: string }> = req.items && req.items.length > 0
      ? req.items
      : (req.ids ?? []).map((id) => ({ id }));
    for (const item of items) {
      const r = del({
        workflow: req.workflow,
        id: item.id,
        date: req.date,
        ...(item.runId ? { runId: item.runId } : {}),
      });
      if (r.ok) count++;
      else errors.push({ id: item.id, error: r.error });
    }
    return { ok: true, count, errors };
  };
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
