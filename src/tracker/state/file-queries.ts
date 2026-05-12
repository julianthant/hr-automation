import type { Database } from "../../infra/sqlite/index.js";

export interface FileRow {
  file_id: string;
  kind: string;
  storage_path: string;
  workflow: string | null;
  item_id: string | null;
  run_id: string | null;
  source: string;
  bytes: number;
  created_at: string; // ISO-8601
  last_accessed_at: string | null;
}

/**
 * List every screenshot registered in the `files` table for a workflow +
 * itemId. The schema indexes on (workflow, item_id, run_id) so this is a
 * direct seek. Files whose storage_path no longer exists on disk should be
 * filtered by the caller via `existsSync` — projection rebuild does not
 * unregister files when the disk copy is removed by `cleanOldScreenshots`.
 */
export function queryScreenshotsForItem(
  db: Database,
  opts: { workflow: string; itemId: string; runId?: string | null },
): FileRow[] {
  const runId = opts.runId?.trim();
  if (runId) {
    return db.prepare(`
      SELECT file_id, kind, storage_path, workflow, item_id, run_id, source, bytes,
             created_at, last_accessed_at
      FROM files
      WHERE workflow = @workflow AND item_id = @itemId AND kind = 'screenshot'
        AND run_id = @runId
      ORDER BY created_at DESC
    `).all({ workflow: opts.workflow, itemId: opts.itemId, runId }) as FileRow[];
  }
  return db.prepare(`
    SELECT file_id, kind, storage_path, workflow, item_id, run_id, source, bytes,
           created_at, last_accessed_at
    FROM files
    WHERE workflow = @workflow AND item_id = @itemId AND kind = 'screenshot'
    ORDER BY created_at DESC
  `).all(opts) as FileRow[];
}
