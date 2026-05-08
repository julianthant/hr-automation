import {
  isStateDbReady,
  openStateDb,
} from "./db.js";
import { transaction } from "../../infra/sqlite/index.js";

export interface PruneResult {
  runEventsDeleted: number;
  runsDeleted: number;
  itemsDeleted: number;
  logsDeleted: number;
  sessionEventsDeleted: number;
  filesDeleted: number;
  taskAttemptsDeleted: number;
  workerCommandsDeleted: number;
}

/**
 * Delete every projected row whose tracker_date (or timestamp, for tables
 * lacking tracker_date) is older than `cutoffDate` (YYYY-MM-DD ISO). Runs in
 * a single transaction via the shim's `transaction(db, fn)` so a partial
 * prune can't half-update the DB. VACUUM runs after commit (best-effort).
 *
 * Returns counts per table for log output. No-op (returns zeros) when the
 * projection isn't ready.
 *
 * Schema notes verified against src/tracker/state/schema.ts:
 * - run_events, runs, items, logs: tracker_date TEXT NOT NULL
 * - session_events: ts_ms INTEGER NOT NULL (numeric comparison)
 * - files: created_at TEXT ISO
 * - task_attempts: created_at TEXT ISO
 * - worker_commands: requested_at TEXT ISO (NOT created_at — verified in schema.ts)
 */
export function pruneStateDb(dir: string, cutoffDate: string): PruneResult {
  const zero: PruneResult = {
    runEventsDeleted: 0,
    runsDeleted: 0,
    itemsDeleted: 0,
    logsDeleted: 0,
    sessionEventsDeleted: 0,
    filesDeleted: 0,
    taskAttemptsDeleted: 0,
    workerCommandsDeleted: 0,
  };
  if (!isStateDbReady(dir)) return zero;
  const db = openStateDb(dir);
  const cutoffIso = `${cutoffDate}T00:00:00.000Z`;
  const cutoffMs = Date.parse(cutoffIso);
  const result = { ...zero };

  transaction(db, () => {
    result.runEventsDeleted = db
      .prepare("DELETE FROM run_events WHERE tracker_date < @cutoffDate")
      .run({ cutoffDate }).changes;
    result.runsDeleted = db
      .prepare("DELETE FROM runs WHERE tracker_date < @cutoffDate")
      .run({ cutoffDate }).changes;
    result.itemsDeleted = db
      .prepare("DELETE FROM items WHERE tracker_date < @cutoffDate")
      .run({ cutoffDate }).changes;
    result.logsDeleted = db
      .prepare("DELETE FROM logs WHERE tracker_date < @cutoffDate")
      .run({ cutoffDate }).changes;
    // session_events stores ts_ms as INTEGER — numeric comparison required.
    result.sessionEventsDeleted = db
      .prepare("DELETE FROM session_events WHERE ts_ms < @cutoffMs")
      .run({ cutoffMs }).changes;
    // files: created_at TEXT ISO — string comparison works for ISO format.
    result.filesDeleted = db
      .prepare("DELETE FROM files WHERE created_at < @cutoffIso")
      .run({ cutoffIso }).changes;
    // Only prune terminal task_attempts. A non-terminal attempt with an old
    // created_at (e.g. a long-lived daemon) still owns `tasks.current_attempt_id`
    // (FK ON DELETE SET NULL) and `worker_commands.target_attempt_id`, and
    // deleting it would silently null those references on a live row.
    result.taskAttemptsDeleted = db
      .prepare(
        "DELETE FROM task_attempts WHERE created_at < @cutoffIso " +
          "AND status IN ('done', 'failed', 'cancelled')",
      )
      .run({ cutoffIso }).changes;
    // worker_commands: uses requested_at TEXT ISO (not created_at — verified in schema.ts).
    result.workerCommandsDeleted = db
      .prepare("DELETE FROM worker_commands WHERE requested_at < @cutoffIso")
      .run({ cutoffIso }).changes;
  });

  // VACUUM cannot run inside a transaction. Best-effort — WAL exclusive
  // locking can fail if another connection is open; that's fine, the next
  // run will pick it up.
  try {
    db.exec("VACUUM");
  } catch {
    /* skip if busy */
  }

  return result;
}
