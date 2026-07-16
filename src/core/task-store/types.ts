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

export type TaskTransitionOutcome =
  | { kind: 'applied' }
  | { kind: 'already-terminal'; state: Extract<TaskState, 'done' | 'failed' | 'cancelled'> }
  | { kind: 'lease-lost' }
  | { kind: 'not-found' }

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
  claimGeneration?: number
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
  /**
   * The claim lease this worker holds (ISS-005). Bumped on every claim; a peer
   * re-claiming a re-pended task advances it again, so the original worker's
   * stale lease no longer matches and its terminal write is rejected. Thread
   * this through to `markTaskDone`/`markTaskFailed` to guard the completion.
   */
  claimGeneration: number
  parentRunId?: string
}

export interface EnqueuedTask {
  id: string
  itemId: string
  taskId: string
  attemptId: string
  runId: string
  position: number
  parentRunId?: string
  /** True when idempotent enqueue adopted an unchanged existing task. */
  reused?: boolean
}

export type CancelTaskResult =
  | {
      kind: 'accepted'
      task: TaskRow
      disposition: 'requested' | 'already-requested' | 'cancelled-before-run'
    }
  | { kind: 'already-terminal'; task: TaskRow }
  | { kind: 'not-found' }

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
  /** Exact replay: verify and return an existing identity without mutating it. */
  existingTaskPolicy?: 'adopt' | 'idempotent'
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
  current_attempt_id: string | null
  claimed_by_worker_id: string | null
  enqueued_at: string | null
  claimed_at: string | null
  claim_expires_at: string | null
  claim_generation: number
  terminal_at: string | null
  terminal_error: string | null
}

export interface AttemptDbRow {
  id: string
  task_id: string
  attempt_no: number
  run_id: string
  control_state: AttemptState | null
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
    claimGeneration: row.claim_generation,
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
    state: normalizeAttemptState(row),
  }
  if (row.worker_id) attempt.workerId = row.worker_id
  return attempt
}

const KNOWN_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'queued',
  'waiting_dependencies',
  'claimed',
  'running',
  'cancel_requested',
  'cancelling',
  'cancelled',
  'done',
  'failed',
  'blocked',
])

const KNOWN_ATTEMPT_STATES: ReadonlySet<AttemptState> = new Set<AttemptState>([
  'pending',
  'claimed',
  'running',
  'cancel_requested',
  'cancelled',
  'done',
  'failed',
])

// A NULL/unrecognized `control_state` must never be silently coerced into an
// active-looking state ('queued'/'pending') — that would let a corrupted
// terminal (e.g. 'done') row get treated as cancellable-as-queued (fail loud,
// per root CLAUDE.md). Throw naming the offending row instead.
export function normalizeTaskState(row: TaskDbRow): TaskState {
  const state = row.control_state
  if (state !== null && KNOWN_TASK_STATES.has(state)) return state
  throw new Error(
    `normalizeTaskState: task ${row.id} has an invalid control_state (${JSON.stringify(state)}) — ` +
      `refusing to silently treat a NULL/unrecognized state as 'queued'`,
  )
}

export function normalizeAttemptState(row: AttemptDbRow): AttemptState {
  const state = row.control_state
  if (state !== null && KNOWN_ATTEMPT_STATES.has(state)) return state
  throw new Error(
    `normalizeAttemptState: attempt ${row.id} (task ${row.task_id}) has an invalid control_state ` +
      `(${JSON.stringify(state)}) — refusing to silently treat a NULL/unrecognized state as 'pending'`,
  )
}

export function isTerminalTaskState(
  state: TaskState,
): state is Extract<TaskState, 'done' | 'failed' | 'cancelled'> {
  return state === 'done' || state === 'failed' || state === 'cancelled'
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new Error(`parseJson: malformed JSON (${message}): ${raw.slice(0, 200)}`, { cause: e })
  }
}

export function getTaskRaw(db: Database, taskId: string): TaskDbRow | null {
  return (db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskDbRow | undefined) ?? null
}

export function getMappedTask(db: Database, taskId: string): TaskRow | null {
  const row = getTaskRaw(db, taskId)
  return row ? mapTaskRow(row) : null
}
