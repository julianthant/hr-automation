import { type UUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonsDir, ensureDaemonsDir } from './registry.js'
import type { QueueEvent, QueueItem, QueueState } from './types.js'
import { openControlDb } from '../control-db.js'
import { createTaskStore, type TaskRow } from '../task-store/index.js'
import { mapTaskRow, type TaskDbRow } from '../task-store/types.js'

function openQueueTaskStore(trackerDir?: string) {
  return createTaskStore(openControlDb({ trackerDir }))
}

export function queueFilePath(workflow: string, trackerDir?: string): string {
  return join(daemonsDir(trackerDir), `${workflow}.queue.jsonl`)
}

export function queueLockDirPath(workflow: string, trackerDir?: string): string {
  return join(daemonsDir(trackerDir), `${workflow}.queue.lock`)
}

/**
 * Append one JSONL line atomically. On POSIX, `appendFileSync` with flag 'a'
 * is atomic for writes under PIPE_BUF (4KB); our event lines are all well
 * under that. No mutex needed.
 *
 * This is an audit-only write. The `.queue.jsonl` file in `.tracker/daemons/`
 * is an append-only audit trail — readers must not consume it as state.
 * Queue authority is SQLite via `openQueueTaskStore`.
 */
function appendEvent(workflow: string, event: QueueEvent, trackerDir?: string): void {
  ensureDaemonsDir(trackerDir)
  const path = queueFilePath(workflow, trackerDir)
  appendFileSync(path, JSON.stringify(event) + '\n')
}

function nowIso(): string {
  return new Date().toISOString()
}

export async function readQueueState(workflow: string, trackerDir?: string): Promise<QueueState> {
  const store = openQueueTaskStore(trackerDir)
  const state: QueueState = { queued: [], claimed: [], done: [], failed: [] }
  // One query for full task rows. Previous shape (SELECT id then per-id
  // store.getTask) was N+1 prepared-statement executions per call.
  const rows = store.db.prepare(`
    SELECT *
    FROM tasks
    WHERE workflow = ?
      AND task_kind = 'workflow_item'
      AND source = 'daemon'
    ORDER BY COALESCE(enqueued_at, created_at) ASC, rowid ASC
  `).all(workflow) as Array<TaskDbRow>
  for (const row of rows) {
    const task = mapTaskRow(row)
    const item = taskToQueueItem(task)
    state[item.state].push(item)
  }
  return state
}

/**
 * Append N `enqueue` events in insertion order. Each event carries a
 * `runId` (UUID v4) so the CLI / HTTP handler can emit a matching `pending`
 * tracker row at enqueue time — when the claiming daemon folds the queue
 * state, it reads this runId and reuses it in its claim event, so the
 * tracker sees ONE runId from pending → running → done (no duplicate rows
 * in the dashboard queue panel). Returns each new item's 1-indexed position
 * in the resulting queued list plus its runId.
 *
 * `preAssignedRunIds`: if provided, each runId is reused verbatim from the
 * caller (e.g. `ensureDaemonsAndEnqueue` pre-assigns them to fire the
 * `onPreEmitPending` callback BEFORE spawn — the same runId then rides
 * through to the queue file's enqueue event). Length must match `inputs`.
 * If omitted, one fresh UUID is generated per input (legacy behavior).
 *
 * `preAssignedParentRunIds`: parallel array; when set, each item's enqueue
 * event carries that `parentRunId` for delegation children (e.g. OCR
 * Approve fanning out oath-signature items that each reference the OCR run).
 */
export async function enqueueItems<T>(
  workflow: string,
  inputs: T[],
  idFn: (input: T, index: number) => string,
  trackerDir?: string,
  preAssignedRunIds?: ReadonlyArray<UUID>,
  preAssignedParentRunIds?: ReadonlyArray<string | undefined>,
): Promise<Array<{ id: string; position: number; runId: UUID; taskId?: string; attemptId?: string }>> {
  if (inputs.length === 0) return []
  if (preAssignedRunIds && preAssignedRunIds.length !== inputs.length) {
    throw new Error(
      `enqueueItems: preAssignedRunIds length ${preAssignedRunIds.length} does not match inputs length ${inputs.length}`,
    )
  }
  if (preAssignedParentRunIds && preAssignedParentRunIds.length !== inputs.length) {
    throw new Error(
      `enqueueItems: preAssignedParentRunIds length ${preAssignedParentRunIds.length} does not match inputs length ${inputs.length}`,
    )
  }
  const store = openQueueTaskStore(trackerDir)
  const enqueued = store.control.transaction(() => {
    const ts = nowIso()
    const rows = store.enqueueTasks({
      workflow,
      inputs,
      deriveItemId: idFn,
      runIds: preAssignedRunIds,
      source: 'daemon',
      now: ts,
    })
    const enqueuedBy = `cli-${process.pid}`
    for (let i = 0; i < rows.length; i++) {
      const task = rows[i]
      const parentRunId = preAssignedParentRunIds?.[i]
      if (parentRunId) {
        const row = store.findTaskByIdentity({ workflow, itemId: task.id, runId: task.runId })
        if (row) {
          store.db.prepare('UPDATE tasks SET parent_run_id = ? WHERE id = ?').run(parentRunId, row.taskId)
        }
      }
      // JSONL queue writes are audit-only. Do not use them for claim authority.
      appendEvent(
        workflow,
        {
          type: 'enqueue',
          id: task.id,
          workflow,
          input: inputs[i],
          enqueuedAt: ts,
          enqueuedBy,
          runId: task.runId,
          ...(parentRunId ? { parentRunId } : {}),
        },
        trackerDir,
      )
    }
    return rows
  })
  return enqueued.map((task) => ({
    id: task.id,
    position: task.position,
    runId: task.runId as UUID,
    taskId: task.taskId,
    attemptId: task.attemptId,
  }))
}

export async function claimNextItem(
  workflow: string,
  instanceId: string,
  trackerDir?: string,
): Promise<QueueItem | null> {
  const store = openQueueTaskStore(trackerDir)
  return store.control.transaction(() => {
    const ts = nowIso()
    const claimed = store.claimNextTask({ workflow, workerId: instanceId, now: ts })
    if (!claimed) return null
    appendEvent(
      workflow,
      { type: 'claim', id: claimed.itemId, claimedBy: instanceId, claimedAt: ts, runId: claimed.runId },
      trackerDir,
    )
    return {
      id: claimed.itemId,
      workflow,
      input: claimed.input,
      enqueuedAt: ts,
      state: 'claimed',
      taskId: claimed.taskId,
      attemptId: claimed.attemptId,
      claimedBy: instanceId,
      claimedAt: ts,
      runId: claimed.runId,
      ...(claimed.parentRunId ? { parentRunId: claimed.parentRunId } : {}),
    }
  })
}

type TerminalStatus = 'done' | 'failed' | 'cancelled'

async function markTaskTerminal(
  workflow: string,
  itemId: string,
  runId: string,
  status: TerminalStatus,
  payload: { error?: string; reason?: string },
  trackerDir: string | undefined,
): Promise<void> {
  const store = openQueueTaskStore(trackerDir)
  store.control.transaction(() => {
    const ts = nowIso()
    const task = store.findTaskByIdentity({ workflow, itemId, runId })
    const attemptId = task ? resolveCurrentAttemptId(store, task, runId, ts) : undefined

    if (task) {
      if (status === 'done') {
        if (attemptId) store.markTaskDone({ taskId: task.taskId, attemptId, now: ts })
        else markTaskTerminalWithoutAttempt(store, task.taskId, 'done', ts)
      } else if (status === 'failed') {
        if (attemptId) store.markTaskFailed({ taskId: task.taskId, attemptId, error: payload.error ?? '', now: ts })
        else markTaskTerminalWithoutAttempt(store, task.taskId, 'failed', ts, payload.error)
      } else {
        store.markTaskCancelled({
          taskId: task.taskId,
          ...(attemptId ? { attemptId } : {}),
          reason: payload.reason ?? '',
          now: ts,
        })
      }
    }

    if (status === 'done') {
      appendEvent(workflow, { type: 'done', id: itemId, completedAt: ts, runId }, trackerDir)
    } else {
      const error = status === 'failed' ? (payload.error ?? '') : (payload.reason ?? '')
      appendEvent(workflow, { type: 'failed', id: itemId, failedAt: ts, runId, error }, trackerDir)
    }
  })
}

export async function markItemDone(
  workflow: string,
  itemId: string,
  runId: string,
  trackerDir?: string,
): Promise<void> {
  return markTaskTerminal(workflow, itemId, runId, 'done', {}, trackerDir)
}

export async function markItemFailed(
  workflow: string,
  itemId: string,
  error: string,
  runId: string,
  trackerDir?: string,
): Promise<void> {
  return markTaskTerminal(workflow, itemId, runId, 'failed', { error }, trackerDir)
}

export async function markItemCancelled(
  workflow: string,
  itemId: string,
  reason: string,
  runId: string,
  trackerDir?: string,
): Promise<void> {
  return markTaskTerminal(workflow, itemId, runId, 'cancelled', { reason }, trackerDir)
}

export async function unclaimItem(
  workflow: string,
  itemId: string,
  reason: 'recovered' | 'sigint-soft' | 'voluntary',
  trackerDir?: string,
  runId?: string,
): Promise<void> {
  if (reason !== 'recovered' && !runId) {
    throw new Error(`unclaimItem(${workflow}/${itemId}) requires runId when reason=${reason}`)
  }
  const store = openQueueTaskStore(trackerDir)
  store.control.transaction(() => {
    const ts = nowIso()
    const task = store.findTaskByIdentity({ workflow, itemId, ...(runId ? { runId } : {}) })
    if (task) store.returnTaskToQueued({ taskId: task.taskId, now: ts })
    appendEvent(workflow, { type: 'unclaim', id: itemId, reason, ts }, trackerDir)
  })
}

export async function recoverOrphanedClaims(
  workflow: string,
  aliveInstanceIds: Set<string>,
  trackerDir?: string,
): Promise<number> {
  const store = openQueueTaskStore(trackerDir)
  return store.control.transaction(() => {
    const ts = nowIso()
    const recovered = store.recoverClaimsForDeadWorkers({ workflow, aliveWorkerIds: aliveInstanceIds, now: ts })
    for (const task of recovered) {
      appendEvent(workflow, { type: 'unclaim', id: task.itemId, reason: 'recovered', ts }, trackerDir)
    }
    return recovered.length
  })
}

function taskToQueueItem(task: TaskRow): QueueItem {
  const state = queueStateFromTask(task)
  const item: QueueItem = {
    id: task.itemId,
    workflow: task.workflow,
    input: task.input,
    enqueuedAt: task.enqueuedAt ?? new Date().toISOString(),
    state,
    taskId: task.taskId,
  }
  if (task.currentAttemptId) item.attemptId = task.currentAttemptId
  if (task.claimedByWorkerId) item.claimedBy = task.claimedByWorkerId
  if (task.claimedAt) item.claimedAt = task.claimedAt
  if (task.currentRunId ?? task.runId) item.runId = task.currentRunId ?? task.runId
  if (task.parentRunId) item.parentRunId = task.parentRunId
  if (state === 'done' && task.terminalAt) item.completedAt = task.terminalAt
  if (state === 'failed') {
    if (task.terminalAt) item.failedAt = task.terminalAt
    if (task.error) item.error = task.error
  }
  return item
}

function resolveCurrentAttemptId(
  store: ReturnType<typeof openQueueTaskStore>,
  task: TaskRow,
  runId: string,
  now: string = nowIso(),
): string | undefined {
  if (task.currentAttemptId) return task.currentAttemptId
  const row = store.db.prepare(`
    SELECT id
    FROM task_attempts
    WHERE task_id = @taskId
      AND run_id = @runId
    ORDER BY attempt_no DESC
    LIMIT 1
  `).get({ taskId: task.taskId, runId }) as { id: string } | undefined
  if (!row) return undefined
  store.db.prepare(`
    UPDATE tasks
    SET current_attempt_id = @attemptId,
        updated_at = @now
    WHERE id = @taskId
  `).run({ taskId: task.taskId, attemptId: row.id, now })
  return row.id
}

function markTaskTerminalWithoutAttempt(
  store: ReturnType<typeof openQueueTaskStore>,
  taskId: string,
  state: 'done' | 'failed',
  now: string = nowIso(),
  error?: string,
): void {
  store.db.prepare(`
    UPDATE tasks
    SET control_state = @state,
        status = @state,
        terminal_error = @error,
        terminal_at = COALESCE(terminal_at, @now),
        claimed_by_worker_id = NULL,
        claim_expires_at = NULL,
        updated_at = @now
    WHERE id = @taskId
  `).run({ taskId, state, error: error ?? null, now })
}

function queueStateFromTask(task: TaskRow): QueueItem['state'] {
  if (task.state === 'done') return 'done'
  if (task.state === 'failed' || task.state === 'cancelled' || task.state === 'blocked') return 'failed'
  if (
    task.state === 'claimed' ||
    task.state === 'running' ||
    task.state === 'cancel_requested' ||
    task.state === 'cancelling'
  ) {
    return 'claimed'
  }
  return 'queued'
}
