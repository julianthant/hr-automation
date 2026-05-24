import { randomUUID } from 'node:crypto'

import { type Database } from '../../infra/sqlite/index.js'

import type { ControlDb } from '../control-db.js'
import {
  type EnqueueTasksRequest,
  type EnqueuedTask,
  type TaskDbRow,
  type AttemptDbRow,
} from './types.js'

export function enqueueTasks<T>(db: Database, control: ControlDb, request: EnqueueTasksRequest<T>): EnqueuedTask[] {
  if (request.runIds && request.runIds.length !== request.inputs.length) {
    throw new Error(`enqueueTasks: runIds length ${request.runIds.length} does not match inputs length ${request.inputs.length}`)
  }
  if (request.inputs.length === 0) return []
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const basePosition = (db.prepare(`
      SELECT COUNT(*) AS n
      FROM tasks
      WHERE workflow = ?
        AND task_kind = 'workflow_item'
        AND source = 'daemon'
        AND control_state = 'queued'
    `).get(request.workflow) as { n: number }).n

    return request.inputs.map((input, index) => {
      const itemId = request.deriveItemId(input, index)
      const runId = request.runIds?.[index] ?? randomUUID()
      const inputJson = JSON.stringify(input)
      const existing = findTaskByWorkflowItemRunRaw(db, {
        workflow: request.workflow,
        itemId,
        runId,
      })
      if (existing) {
        return adoptExistingTaskForEnqueue(db, {
          task: existing,
          workflow: request.workflow,
          itemId,
          runId,
          inputJson,
          parentTaskId: request.parentTaskId,
          parentRunId: request.parentRunId,
          source: request.source ?? 'daemon',
          metadataJson: request.metadata ? JSON.stringify(request.metadata) : null,
          now,
          position: basePosition + index + 1,
        })
      }

      const taskId = randomUUID()
      const attemptId = randomUUID()
      // Contract 2: stamp the pristine original input on the task at first
      // enqueue. `retryTaskFromAttempt` runs the same task with a new attempt
      // and run id; the original_input_json column is the source of truth for
      // what the retry handler will see, NOT input_json (which may be edited
      // by edit-and-resume or future migrations).
      db.prepare(`
        INSERT INTO tasks (
          id, workflow, item_id, run_id, task_kind, parent_task_id,
          data_json, input_json, original_input_json, control_state, priority, available_at,
          enqueued_at, current_attempt_id, parent_run_id, source, metadata_json,
          created_at, updated_at, terminal_at
        ) VALUES (
          @taskId, @workflow, @itemId, @runId, 'workflow_item', @parentTaskId,
          '{}', @inputJson, @inputJson, 'queued', 0, @now,
          @now, NULL, @parentRunId, @source, @metadataJson,
          @now, @now, NULL
        )
      `).run({
        taskId,
        workflow: request.workflow,
        itemId,
        runId,
        parentTaskId: request.parentTaskId ?? null,
        inputJson,
        now,
        attemptId,
        parentRunId: request.parentRunId ?? null,
        source: request.source ?? 'daemon',
        metadataJson: request.metadata ? JSON.stringify(request.metadata) : null,
      })
      db.prepare(`
        INSERT INTO task_attempts (
          id, task_id, attempt_no, run_id, control_state,
          tracker_workflow, tracker_item_id, data_json, created_at, updated_at
        ) VALUES (
          @attemptId, @taskId, 1, @runId, 'pending',
          @workflow, @itemId, '{}', @now, @now
        )
      `).run({ attemptId, taskId, runId, workflow: request.workflow, itemId, now })
      db.prepare(`
        UPDATE tasks
        SET current_attempt_id = @attemptId
        WHERE id = @taskId
      `).run({ taskId, attemptId })
      return {
        id: itemId,
        itemId,
        taskId,
        attemptId,
        runId,
        position: basePosition + index + 1,
      }
    })
  })
}

function adoptExistingTaskForEnqueue(
  db: Database,
  request: {
    task: TaskDbRow
    workflow: string
    itemId: string
    runId: string
    inputJson: string
    parentTaskId?: string
    parentRunId?: string
    source: string
    metadataJson: string | null
    now: string
    position: number
  },
): EnqueuedTask {
  const attemptId = ensureQueuedAttemptForTask(db, request)
  // Post-migration-11 every task row is written with original_input_json at
  // INSERT time. `retryTaskFromAttempt` already hard-fails on any row that
  // would reach this path without a stamped original — so the COALESCE
  // fallback is dead. Use @inputJson directly.
  db.prepare(`
    UPDATE tasks
    SET input_json = @inputJson,
        original_input_json = @inputJson,
        control_state = 'queued',
        priority = 0,
        available_at = @now,
        enqueued_at = COALESCE(enqueued_at, @now),
        current_attempt_id = @attemptId,
        parent_task_id = COALESCE(@parentTaskId, parent_task_id),
        parent_run_id = COALESCE(@parentRunId, parent_run_id),
        claimed_by_worker_id = NULL,
        claimed_at = NULL,
        claim_expires_at = NULL,
        cancel_requested_at = NULL,
        cancel_reason = NULL,
        terminal_at = NULL,
        terminal_error = NULL,
        source = @source,
        metadata_json = @metadataJson,
        updated_at = @now
    WHERE id = @taskId
  `).run({
    taskId: request.task.id,
    attemptId,
    inputJson: request.inputJson,
    parentTaskId: request.parentTaskId ?? null,
    parentRunId: request.parentRunId ?? null,
    source: request.source,
    metadataJson: request.metadataJson,
    now: request.now,
  })
  return {
    id: request.itemId,
    itemId: request.itemId,
    taskId: request.task.id,
    attemptId,
    runId: request.runId,
    position: request.position,
  }
}

function ensureQueuedAttemptForTask(
  db: Database,
  request: {
    task: TaskDbRow
    workflow: string
    itemId: string
    runId: string
    now: string
  },
): string {
  const existing = db.prepare(`
    SELECT *
    FROM task_attempts
    WHERE tracker_workflow = @workflow
      AND tracker_item_id = @itemId
      AND run_id = @runId
    ORDER BY attempt_no DESC
    LIMIT 1
  `).get(request) as AttemptDbRow | undefined
  if (existing) {
    db.prepare(`
      UPDATE task_attempts
      SET task_id = @taskId,
          control_state = 'pending',
          tracker_workflow = @workflow,
          tracker_item_id = @itemId,
          data_json = '{}',
          worker_id = NULL,
          claimed_at = NULL,
          failed_at = NULL,
          error = NULL,
          started_at = NULL,
          terminal_at = NULL,
          updated_at = @now
      WHERE id = @attemptId
    `).run({
      attemptId: existing.id,
      taskId: request.task.id,
      workflow: request.workflow,
      itemId: request.itemId,
      now: request.now,
    })
    return existing.id
  }

  const attemptNo = ((db.prepare(`
    SELECT COALESCE(MAX(attempt_no), 0) AS n
    FROM task_attempts
    WHERE task_id = ?
  `).get(request.task.id) as { n: number }).n) + 1
  const attemptId = randomUUID()
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
    taskId: request.task.id,
    attemptNo,
    runId: request.runId,
    workflow: request.workflow,
    itemId: request.itemId,
    now: request.now,
  })
  return attemptId
}

export function findTaskByWorkflowItemRunRaw(
  db: Database,
  request: { workflow: string; itemId: string; runId: string },
): TaskDbRow | null {
  return (
    db.prepare(`
      SELECT *
      FROM tasks
      WHERE workflow = @workflow
        AND item_id = @itemId
        AND run_id = @runId
        AND task_kind = 'workflow_item'
      LIMIT 1
    `).get(request) as TaskDbRow | undefined
  ) ?? null
}
