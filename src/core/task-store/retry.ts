import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

import type { ControlDb } from '../control-db.js'
import { type EnqueuedTask, type AttemptDbRow } from './types.js'

export function retryTaskFromAttempt(
  db: Database.Database,
  control: ControlDb,
  request: { runId: string; now?: string },
): EnqueuedTask {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const prior = db.prepare(`
      SELECT a.*, t.workflow, t.item_id, t.input_json
      FROM task_attempts a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.run_id = @runId
      LIMIT 1
    `).get({ runId: request.runId }) as (AttemptDbRow & { workflow: string; item_id: string; input_json: string }) | undefined
    if (!prior) throw new Error(`No task attempt found for runId ${request.runId}`)
    const nextAttemptNo = ((db.prepare(`
      SELECT COALESCE(MAX(attempt_no), 0) AS n
      FROM task_attempts
      WHERE task_id = ?
    `).get(prior.task_id) as { n: number }).n) + 1
    const attemptId = randomUUID()
    const runId = randomUUID()
    db.prepare(`
      INSERT INTO task_attempts (
        id, task_id, attempt_no, run_id, status, control_state,
        tracker_workflow, tracker_item_id, data_json, created_at, updated_at
      ) VALUES (
        @attemptId, @taskId, @attemptNo, @runId, 'queued', 'pending',
        @workflow, @itemId, '{}', @now, @now
      )
    `).run({
      attemptId,
      taskId: prior.task_id,
      attemptNo: nextAttemptNo,
      runId,
      workflow: prior.workflow,
      itemId: prior.item_id,
      now,
    })
    db.prepare(`
      UPDATE tasks
      SET control_state = 'queued',
          status = 'queued',
          run_id = @runId,
          current_attempt_id = @attemptId,
          claimed_by_worker_id = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL,
          cancel_requested_at = NULL,
          cancel_reason = NULL,
          terminal_at = NULL,
          terminal_error = NULL,
          updated_at = @now
      WHERE id = @taskId
    `).run({ taskId: prior.task_id, runId, attemptId, now })
    const position = (db.prepare(`
      SELECT COUNT(*) AS n
      FROM tasks
      WHERE workflow = ?
        AND task_kind = 'workflow_item'
        AND source = 'daemon'
        AND control_state = 'queued'
    `).get(prior.workflow) as { n: number }).n
    return {
      id: prior.item_id,
      itemId: prior.item_id,
      taskId: prior.task_id,
      attemptId,
      runId,
      position,
    }
  })
}
