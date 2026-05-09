import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
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

/**
 * Hard-delete JSONL rows and SQLite records for a tracker entry.
 *
 * Without `runId`, this removes the entire queue item. With `runId`, this
 * removes only that run while preserving other attempts for the same item.
 * The parse cache in jsonl.ts invalidates on next read because the file's
 * mtime changes after the rewrite.
 */
export function buildDeleteEntryHandler(dir: string) {
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
