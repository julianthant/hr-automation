import { randomUUID } from 'node:crypto'

import { type Database } from '../../infra/sqlite/index.js'

import type { ControlDb } from '../control-db.js'
import { type EnqueuedTask, type AttemptDbRow } from './types.js'

export function retryTaskFromAttempt(
  db: Database,
  control: ControlDb,
  request: { runId: string; now?: string },
): EnqueuedTask {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const prior = db.prepare(`
      SELECT a.*, t.workflow, t.item_id, t.original_input_json, t.parent_run_id
      FROM task_attempts a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.run_id = @runId
      LIMIT 1
    `).get({ runId: request.runId }) as (AttemptDbRow & {
      workflow: string
      item_id: string
      original_input_json: string | null
      parent_run_id: string | null
    }) | undefined
    if (!prior) throw new Error(`No task attempt found for runId ${request.runId}`)
    /**
     * Contract 2 (Uniform Retry): the new attempt runs against the PRISTINE
     * original input the task was first enqueued with. Reset input_json to
     * original_input_json so the daemon's claim path (parseJson(row.input_json))
     * hands the handler the same payload the first attempt saw, with no
     * accumulated state from intervening edits or adopt-existing overwrites.
     *
     * Legacy rows from before migration 11 have original_input_json = NULL.
     * The retry path throws hard for those rows instead of silently falling
     * back to current input_json, because retrying mutated input violates the
     * Contract 2 replay invariant.
     */
    if (prior.original_input_json == null) {
      throw new Error(
        `retryTaskFromAttempt: task ${prior.task_id} has no original_input_json (legacy pre-migration-11 row). Contract 2 requires every retryable row to have original_input_json. Either delete the row and re-enqueue, or repair the row manually.`,
      )
    }
    const resetInputJson = prior.original_input_json
    const nextAttemptNo = ((db.prepare(`
      SELECT COALESCE(MAX(attempt_no), 0) AS n
      FROM task_attempts
      WHERE task_id = ?
    `).get(prior.task_id) as { n: number }).n) + 1
    const attemptId = randomUUID()
    const runId = randomUUID()
    db.prepare(`
      INSERT INTO task_attempts (
        id, task_id, attempt_no, run_id, control_state,
        tracker_workflow, tracker_item_id, data_json, created_at, updated_at
      ) VALUES (
        @attemptId, @taskId, @attemptNo, @runId, 'pending',
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
          run_id = @runId,
          input_json = @resetInputJson,
          current_attempt_id = @attemptId,
          claimed_by_worker_id = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL,
          cancel_requested_at = NULL,
          cancel_reason = NULL,
          terminal_at = NULL,
          terminal_error = NULL,
          parent_run_id = parent_run_id,
          updated_at = @now
      WHERE id = @taskId
    `).run({ taskId: prior.task_id, runId, resetInputJson, attemptId, now })
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
      ...(prior.parent_run_id ? { parentRunId: prior.parent_run_id } : {}),
    }
  })
}
