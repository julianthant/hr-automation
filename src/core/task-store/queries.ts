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

export function listTasksForWorkflow(db: Database, workflow: string): TaskRow[] {
  const rows = db.prepare(`
    SELECT *
    FROM tasks
    WHERE workflow = ?
    ORDER BY COALESCE(enqueued_at, created_at) ASC, rowid ASC
  `).all(workflow) as TaskDbRow[]
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
