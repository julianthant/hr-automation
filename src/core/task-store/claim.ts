import type Database from 'better-sqlite3'

import type { ControlDb } from '../control-db.js'
import {
  type ClaimedTask,
  type TaskDbRow,
  getTaskRaw,
  parseJson,
} from './types.js'

export function claimNextTask(
  db: Database.Database,
  control: ControlDb,
  request: { workflow: string; workerId: string; now?: string; leaseMs?: number },
): ClaimedTask | null {
  const now = request.now ?? new Date().toISOString()
  const claimExpiresAt = new Date(Date.parse(now) + (request.leaseMs ?? 60_000)).toISOString()
  const canReturn = control.supportsUpdateReturning()
  return canReturn
    ? claimNextTaskReturning(db, control, { ...request, now, claimExpiresAt })
    : claimNextTaskFallback(db, control, { ...request, now, claimExpiresAt })
}

function claimNextTaskReturning(
  db: Database.Database,
  control: ControlDb,
  request: { workflow: string; workerId: string; now: string; claimExpiresAt: string },
): ClaimedTask | null {
  return control.transaction(() => {
    const row = db.prepare(`
      WITH next_task AS (
        SELECT id
        FROM tasks
        WHERE workflow = @workflow
          AND task_kind = 'workflow_item'
          AND source = 'daemon'
          AND control_state = 'queued'
          AND COALESCE(available_at, created_at) <= @now
          AND NOT EXISTS (
            SELECT 1
            FROM task_dependencies d
            WHERE d.parent_task_id = tasks.id
              AND d.status NOT IN ('satisfied', 'cancelled')
          )
        ORDER BY priority DESC, COALESCE(enqueued_at, created_at) ASC, rowid ASC
        LIMIT 1
      )
      UPDATE tasks
      SET control_state = 'claimed',
          claimed_by_worker_id = @workerId,
          claimed_at = @now,
          claim_expires_at = @claimExpiresAt,
          updated_at = @now
      WHERE id = (SELECT id FROM next_task)
      RETURNING *
    `).get(request) as TaskDbRow | undefined
    if (!row?.current_attempt_id) return null
    markAttemptClaimed(db, row.current_attempt_id, request.workerId, request.now)
    return claimedFromTaskRow(db, row, request.workerId)
  })
}

function claimNextTaskFallback(
  db: Database.Database,
  control: ControlDb,
  request: { workflow: string; workerId: string; now: string; claimExpiresAt: string },
): ClaimedTask | null {
  return control.transaction(() => {
    const next = db.prepare(`
      SELECT *
      FROM tasks
      WHERE workflow = @workflow
        AND task_kind = 'workflow_item'
        AND source = 'daemon'
        AND control_state = 'queued'
        AND COALESCE(available_at, created_at) <= @now
        AND NOT EXISTS (
          SELECT 1
          FROM task_dependencies d
          WHERE d.parent_task_id = tasks.id
            AND d.status NOT IN ('satisfied', 'cancelled')
        )
      ORDER BY priority DESC, COALESCE(enqueued_at, created_at) ASC, rowid ASC
      LIMIT 1
    `).get(request) as TaskDbRow | undefined
    if (!next?.current_attempt_id) return null
    const info = db.prepare(`
      UPDATE tasks
      SET control_state = 'claimed',
          claimed_by_worker_id = @workerId,
          claimed_at = @now,
          claim_expires_at = @claimExpiresAt,
          updated_at = @now
      WHERE id = @taskId AND control_state = 'queued'
    `).run({ ...request, taskId: next.id })
    if (info.changes !== 1) return null
    markAttemptClaimed(db, next.current_attempt_id, request.workerId, request.now)
    const claimed = db.prepare('SELECT * FROM tasks WHERE id = ?').get(next.id) as TaskDbRow
    return claimedFromTaskRow(db, claimed, request.workerId)
  })
}

export function markAttemptClaimed(db: Database.Database, attemptId: string, workerId: string, now: string): void {
  db.prepare(`
    UPDATE task_attempts
    SET control_state = 'claimed',
        worker_id = @workerId,
        claimed_at = @now,
        updated_at = @now
    WHERE id = @attemptId
  `).run({ attemptId, workerId, now })
}

export function markTaskRunning(
  db: Database.Database,
  control: ControlDb,
  request: { taskId: string; attemptId: string; workerId: string; now?: string },
): void {
  const now = request.now ?? new Date().toISOString()
  control.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET control_state = 'running',
          status = 'running',
          claimed_by_worker_id = @workerId,
          current_attempt_id = @attemptId,
          updated_at = @now
      WHERE id = @taskId
    `).run({ ...request, now })
    db.prepare(`
      UPDATE task_attempts
      SET control_state = 'running',
          status = 'running',
          worker_id = @workerId,
          started_at = COALESCE(started_at, @now),
          updated_at = @now
      WHERE id = @attemptId
    `).run({ ...request, now })
  })
}

export function returnTaskToQueued(
  db: Database.Database,
  control: ControlDb,
  request: { taskId: string; now?: string },
): void {
  const now = request.now ?? new Date().toISOString()
  control.transaction(() => {
    const task = getTaskRaw(db, request.taskId)
    if (!task?.current_attempt_id) return
    db.prepare(`
      UPDATE tasks
      SET control_state = 'queued',
          status = 'queued',
          claimed_by_worker_id = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL,
          updated_at = @now
      WHERE id = @taskId AND control_state IN ('claimed', 'running')
    `).run({ taskId: request.taskId, now })
    db.prepare(`
      UPDATE task_attempts
      SET control_state = 'pending',
          status = 'queued',
          worker_id = NULL,
          claimed_at = NULL,
          updated_at = @now
      WHERE id = @attemptId AND control_state IN ('claimed', 'running')
    `).run({ attemptId: task.current_attempt_id, now })
  })
}

export function recoverClaimsForDeadWorkers(
  db: Database.Database,
  control: ControlDb,
  request: { workflow: string; aliveWorkerIds: Set<string>; now?: string },
): number {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const rows = db.prepare(`
      SELECT id, claimed_by_worker_id
      FROM tasks
      WHERE workflow = @workflow
        AND task_kind = 'workflow_item'
        AND source = 'daemon'
        AND control_state IN ('claimed', 'running')
        AND claimed_by_worker_id IS NOT NULL
        AND cancel_requested_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM worker_commands c
          WHERE c.target_task_id = tasks.id
            AND c.command_type IN ('cancel_task', 'force_stop_task')
            AND c.state IN ('queued', 'acknowledged')
        )
    `).all({ workflow: request.workflow }) as Array<{ id: string; claimed_by_worker_id: string }>
    let recovered = 0
    for (const row of rows) {
      if (request.aliveWorkerIds.has(row.claimed_by_worker_id)) continue
      returnTaskToQueued(db, control, { taskId: row.id, now })
      recovered++
    }
    return recovered
  })
}

function claimedFromTaskRow(db: Database.Database, row: TaskDbRow, workerId: string): ClaimedTask {
  if (!row.current_attempt_id) throw new Error(`Task ${row.id} has no current attempt`)
  const attempt = db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(row.current_attempt_id) as { id: string; run_id: string }
  const result: ClaimedTask = {
    taskId: row.id,
    attemptId: attempt.id,
    workflow: row.workflow,
    itemId: row.item_id,
    input: parseJson(row.input_json),
    runId: attempt.run_id,
    workerId,
  }
  if (row.parent_run_id) result.parentRunId = row.parent_run_id
  return result
}
