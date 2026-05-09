import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { openStateDb } from "../../state/db.js";
import { transaction } from "../../../infra/sqlite/index.js";

export interface DeleteEntryRequest {
  workflow: string;
  id: string;
  date: string;
}

export type DeleteEntryResult =
  | { ok: true }
  | { ok: false; error: string; status?: number };

/**
 * Hard-delete all JSONL rows and SQLite records for a given entry.
 *
 * Rewrites the tracker JSONL (by id) and the logs JSONL (by itemId),
 * then removes the rows from SQLite across items, runs, logs, and
 * run_events. The parse cache in jsonl.ts will automatically invalidate
 * on next read because the file's mtime changes after the rewrite.
 */
export function buildDeleteEntryHandler(dir: string) {
  return function deleteEntry(req: DeleteEntryRequest): DeleteEntryResult {
    const { workflow, id, date } = req;
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
        return (JSON.parse(line) as { id?: string }).id !== id;
      } catch {
        return true;
      }
    });

    rewriteJsonl(join(dir, `${workflow}-${date}-logs.jsonl`), (line) => {
      try {
        return (JSON.parse(line) as { itemId?: string }).itemId !== id;
      } catch {
        return true;
      }
    });

    const db = openStateDb(dir);
    transaction(db, () => {
      db.prepare("DELETE FROM run_events WHERE workflow = @workflow AND tracker_date = @date AND item_id = @id").run({ workflow, date, id });
      db.prepare("DELETE FROM logs WHERE workflow = @workflow AND tracker_date = @date AND item_id = @id").run({ workflow, date, id });
      db.prepare("DELETE FROM runs WHERE workflow = @workflow AND tracker_date = @date AND item_id = @id").run({ workflow, date, id });
      db.prepare("DELETE FROM items WHERE workflow = @workflow AND tracker_date = @date AND item_id = @id").run({ workflow, date, id });
    });

    return { ok: true };
  };
}
