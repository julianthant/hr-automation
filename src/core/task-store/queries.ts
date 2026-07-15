import { type Database } from '../../infra/sqlite/index.js'

import {
  type TaskRow,
  type AttemptRow,
  type TaskDbRow,
  type AttemptDbRow,
  mapTaskRow,
  mapAttemptRow,
  parseJson,
} from './types.js'

export function getTask(db: Database, taskId: string): TaskRow | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskDbRow | undefined
  return row ? mapTaskRow(row) : null
}

export function getAttempt(db: Database, attemptId: string): AttemptRow | null {
  const row = db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(attemptId) as AttemptDbRow | undefined
  return row ? mapAttemptRow(row) : null
}

export function getTaskByRunId(db: Database, runId: string): TaskRow | null {
  const row = db.prepare(`
    SELECT t.*
    FROM task_attempts a
    JOIN tasks t ON t.id = a.task_id
    WHERE a.run_id = ?
    LIMIT 1
  `).get(runId) as TaskDbRow | undefined
  return row ? mapTaskRow(row) : null
}

export function findTaskByIdentity(
  db: Database,
  request: { workflow: string; itemId: string; runId?: string },
): TaskRow | null {
  const row = request.runId
    ? db.prepare(`
        SELECT t.*
        FROM task_attempts a
        JOIN tasks t ON t.id = a.task_id
        WHERE t.workflow = @workflow
          AND t.item_id = @itemId
          AND a.run_id = @runId
        ORDER BY a.attempt_no DESC
        LIMIT 1
      `).get(request) as TaskDbRow | undefined
    : db.prepare(`
        SELECT *
        FROM tasks
        WHERE workflow = @workflow AND item_id = @itemId
        ORDER BY COALESCE(enqueued_at, created_at) DESC
        LIMIT 1
      `).get(request) as TaskDbRow | undefined
  return row ? mapTaskRow(row) : null
}

export function findInputForRunId(db: Database, runId: string): unknown | null {
  const row = db.prepare(`
    SELECT t.input_json
    FROM task_attempts a
    JOIN tasks t ON t.id = a.task_id
    WHERE a.run_id = ?
    LIMIT 1
  `).get(runId) as { input_json: string } | undefined
  return row ? parseJson(row.input_json) : null
}

/**
 * Contract 2 (Uniform Retry): return the pristine input the task was first
 * enqueued with. Distinct from {@link findInputForRunId}, which returns the
 * task's CURRENT `input_json` (potentially mutated by `adoptExistingTaskForEnqueue`
 * or future edit-and-resume migrations).
 *
 * Returns `null` for legacy rows enqueued before migration 11 — the column is
 * nullable on purpose. The control layer falls back to JSONL reconstruction
 * for those rows.
 */
export function findOriginalInputForRunId(db: Database, runId: string): unknown | null {
  const row = db.prepare(`
    SELECT t.original_input_json
    FROM task_attempts a
    JOIN tasks t ON t.id = a.task_id
    WHERE a.run_id = ?
    LIMIT 1
  `).get(runId) as { original_input_json: string | null } | undefined
  if (!row || row.original_input_json === null) return null
  return parseJson(row.original_input_json)
}

export interface ActiveTaskRef {
  taskId: string
  controlState: string
  runId: string | null
}

/**
 * List the non-terminal ROOT (non-delegated) daemon tasks for one
 * `(workflow, itemId)`, oldest-first.
 *
 * Backs the enqueue "supersede" path that enforces ONE active run per queue
 * row: a fresh dashboard input run cancels any prior queued/in-flight run for
 * the same item before its own row is written. Scoping to `parent_run_id IS
 * NULL` deliberately excludes delegated children (OCR / batch fan-out) so a
 * re-issued root run never disturbs an operation's members. `runId` is the
 * CURRENT attempt's run id (via `current_attempt_id`), so callers can hand it
 * straight to the cancel handlers' `getTaskByRunId` lookup.
 */
export function listActiveRootTasksForItem(
  db: Database,
  request: { workflow: string; itemId: string },
): ActiveTaskRef[] {
  const rows = db.prepare(`
    SELECT t.id AS taskId, t.control_state AS controlState, a.run_id AS runId
    FROM tasks t
    LEFT JOIN task_attempts a ON a.id = t.current_attempt_id
    WHERE t.workflow = @workflow
      AND t.item_id = @itemId
      AND t.task_kind = 'workflow_item'
      AND t.parent_run_id IS NULL
      AND t.control_state NOT IN ('done', 'failed', 'cancelled')
    ORDER BY COALESCE(t.enqueued_at, t.created_at) ASC, t.rowid ASC
  `).all(request) as Array<{ taskId: string; controlState: string; runId: string | null }>
  return rows.map((r) => ({ taskId: r.taskId, controlState: r.controlState, runId: r.runId ?? null }))
}

export function listTasksForWorkflow(db: Database, workflow: string): TaskRow[] {
  const rows = db.prepare(`
    SELECT *
    FROM tasks
    WHERE workflow = ?
    ORDER BY COALESCE(enqueued_at, created_at) ASC, rowid ASC
  `).all(workflow) as TaskDbRow[]
  return rows.map(mapTaskRow)
}

/**
 * Return every task descended from one of `rootRunIds` through the authoritative
 * `tasks.parent_run_id -> tasks.run_id` relationship. The roots themselves are
 * not returned. `UNION` makes a malformed cycle converge instead of recursing
 * forever, while terminal intermediates remain in the CTE so active
 * grandchildren are never hidden behind a completed parent.
 */
export function listTaskTreeByRunIds(
  db: Database,
  request: { rootRunIds: readonly string[] },
): TaskRow[] {
  const rootRunIds = [...new Set(request.rootRunIds.filter(Boolean))]
  if (rootRunIds.length === 0) return []
  const rows = db.prepare(`
    WITH RECURSIVE task_tree AS (
      SELECT t.*
      FROM tasks t
      JOIN json_each(@rootRunIdsJson) roots
        ON t.parent_run_id = roots.value

      UNION

      SELECT child.*
      FROM tasks child
      JOIN task_tree parent
        ON child.parent_run_id = parent.run_id
    )
    SELECT *
    FROM task_tree
    ORDER BY COALESCE(enqueued_at, created_at) ASC, id ASC
  `).all({ rootRunIdsJson: JSON.stringify(rootRunIds) }) as TaskDbRow[]
  return rows.map(mapTaskRow)
}

export function listAttemptsForTask(db: Database, taskId: string): AttemptRow[] {
  const rows = db.prepare(`
    SELECT *
    FROM task_attempts
    WHERE task_id = ?
    ORDER BY attempt_no ASC
  `).all(taskId) as AttemptDbRow[]
  return rows.map(mapAttemptRow)
}

export function countQueued(db: Database, workflow: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS depth
    FROM tasks
    WHERE workflow = @workflow
      AND task_kind = 'workflow_item'
      AND source = 'daemon'
      AND control_state = 'queued'
  `).get({ workflow }) as { depth: number } | undefined
  return row?.depth ?? 0
}
