import { type Database } from '../../infra/sqlite/index.js'

// ── Public types (re-exported from index.ts) ──────────────────────────────────

export type TaskState =
  | 'queued'
  | 'waiting_dependencies'
  | 'claimed'
  | 'running'
  | 'cancel_requested'
  | 'cancelling'
  | 'cancelled'
  | 'done'
  | 'failed'
  | 'blocked'

export type AttemptState =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'cancel_requested'
  | 'cancelled'
  | 'done'
  | 'failed'

export type ChildFailurePolicy = 'fail_parent' | 'block_parent' | 'allow_partial'

export interface TaskRow {
  taskId: string
  workflow: string
  itemId: string
  input: unknown
  state: TaskState
  runId?: string
  parentTaskId?: string
  parentRunId?: string
  currentAttemptId?: string
  currentRunId?: string
  claimedByWorkerId?: string
  enqueuedAt?: string
  claimedAt?: string
  terminalAt?: string
  error?: string
}

export interface AttemptRow {
  attemptId: string
  taskId: string
  attemptNo: number
  runId: string
  state: AttemptState
  workerId?: string
}

export interface ClaimedTask {
  taskId: string
  attemptId: string
  workflow: string
  itemId: string
  input: unknown
  runId: string
  workerId: string
  parentRunId?: string
}

export interface EnqueuedTask {
  id: string
  itemId: string
  taskId: string
  attemptId: string
  runId: string
  position: number
}

export interface EnqueueTasksRequest<T> {
  workflow: string
  inputs: T[]
  deriveItemId: (input: T, index: number) => string
  parentTaskId?: string
  parentRunId?: string
  now?: string
  runIds?: ReadonlyArray<string>
  source?: string
  metadata?: Record<string, unknown>
}

// ── Internal DB row shapes ────────────────────────────────────────────────────

export interface TaskDbRow {
  id: string
  workflow: string
  item_id: string
  run_id: string | null
  parent_task_id: string | null
  parent_run_id: string | null
  input_json: string
  control_state: TaskState | null
  status: string
  current_attempt_id: string | null
  claimed_by_worker_id: string | null
  enqueued_at: string | null
  claimed_at: string | null
  terminal_at: string | null
  terminal_error: string | null
}

export interface AttemptDbRow {
  id: string
  task_id: string
  attempt_no: number
  run_id: string
  control_state: AttemptState | null
  status: string
  worker_id: string | null
}

// ── Shared mapper/utility functions ──────────────────────────────────────────

export function mapTaskRow(row: TaskDbRow): TaskRow {
  const task: TaskRow = {
    taskId: row.id,
    workflow: row.workflow,
    itemId: row.item_id,
    input: parseJson(row.input_json),
    state: normalizeTaskState(row),
  }
  if (row.run_id) {
    task.runId = row.run_id
    task.currentRunId = row.run_id
  }
  if (row.parent_task_id) task.parentTaskId = row.parent_task_id
  if (row.parent_run_id) task.parentRunId = row.parent_run_id
  if (row.current_attempt_id) task.currentAttemptId = row.current_attempt_id
  if (row.claimed_by_worker_id) task.claimedByWorkerId = row.claimed_by_worker_id
  if (row.enqueued_at) task.enqueuedAt = row.enqueued_at
  if (row.claimed_at) task.claimedAt = row.claimed_at
  if (row.terminal_at) task.terminalAt = row.terminal_at
  if (row.terminal_error) task.error = row.terminal_error
  return task
}

export function mapAttemptRow(row: AttemptDbRow): AttemptRow {
  const attempt: AttemptRow = {
    attemptId: row.id,
    taskId: row.task_id,
    attemptNo: row.attempt_no,
    runId: row.run_id,
    state: row.control_state ?? legacyAttemptState(row.status),
  }
  if (row.worker_id) attempt.workerId = row.worker_id
  return attempt
}

export function normalizeTaskState(row: TaskDbRow): TaskState {
  return row.control_state ?? legacyTaskState(row.status)
}

export function legacyTaskState(status: string): TaskState {
  if (status === 'waiting_on_children' || status === 'awaiting_child_results') return 'waiting_dependencies'
  if (status === 'running') return 'running'
  if (status === 'done') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'queued'
}

export function legacyAttemptState(status: string): AttemptState {
  if (status === 'running') return 'running'
  if (status === 'done') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'pending'
}

export function legacyFailurePolicy(policy: ChildFailurePolicy): 'record_unresolved' | 'fail_parent' | 'ignore' {
  if (policy === 'fail_parent') return 'fail_parent'
  if (policy === 'allow_partial') return 'ignore'
  return 'record_unresolved'
}

export function isTerminalTaskState(state: TaskState): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled'
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function getTaskRaw(db: Database, taskId: string): TaskDbRow | null {
  return (db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskDbRow | undefined) ?? null
}

export function getMappedTask(db: Database, taskId: string): TaskRow | null {
  const row = getTaskRaw(db, taskId)
  return row ? mapTaskRow(row) : null
}
