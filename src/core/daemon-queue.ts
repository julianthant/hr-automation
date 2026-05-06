import { randomUUID, type UUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { daemonsDir, ensureDaemonsDir } from './daemon-registry.js'
import type { QueueEvent, QueueItem, QueueState } from './daemon-types.js'
import { openControlDb } from './control-db.js'
import { createTaskStore, type TaskRow } from './task-store.js'

function queueBackend(): 'sqlite' | 'jsonl' {
  return process.env.HRAUTO_QUEUE_BACKEND === 'jsonl' ? 'jsonl' : 'sqlite'
}

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
 */
function appendEvent(workflow: string, event: QueueEvent, trackerDir?: string): void {
  ensureDaemonsDir(trackerDir)
  const path = queueFilePath(workflow, trackerDir)
  appendFileSync(path, JSON.stringify(event) + '\n')
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Read the queue JSONL file and fold events into the current state per id.
 * Malformed / truncated lines are silently skipped (partial writes, corrupted
 * lines). Latest-event-per-id wins: enqueue → queued; enqueue + claim →
 * claimed; enqueue + claim + unclaim → queued (claim-metadata cleared);
 * enqueue + ... + done → done; enqueue + ... + failed → failed.
 */
async function legacyReadQueueState(workflow: string, trackerDir?: string): Promise<QueueState> {
  const path = queueFilePath(workflow, trackerDir)
  if (!existsSync(path)) {
    return { queued: [], claimed: [], done: [], failed: [] }
  }
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  const byId = new Map<string, QueueItem>()

  for (const line of lines) {
    if (!line.trim()) continue
    let ev: QueueEvent
    try {
      ev = JSON.parse(line) as QueueEvent
    } catch {
      continue
    }
    if (!ev || typeof ev !== 'object' || typeof (ev as { type?: unknown }).type !== 'string') {
      continue
    }
    if (ev.type === 'enqueue') {
      byId.set(ev.id, {
        id: ev.id,
        workflow: ev.workflow,
        input: ev.input,
        enqueuedAt: ev.enqueuedAt,
        state: 'queued',
        // Propagate a pre-assigned runId (if the CLI generated one at enqueue
        // time to pair with an onPreEmitPending callback). `claimNextItem`
        // reads this and reuses it in the claim event.
        runId: ev.runId,
        ...(ev.parentRunId ? { parentRunId: ev.parentRunId } : {}),
      })
    } else if (ev.type === 'claim') {
      const existing = byId.get(ev.id)
      if (!existing) continue
      byId.set(ev.id, {
        ...existing,
        state: 'claimed',
        claimedBy: ev.claimedBy,
        claimedAt: ev.claimedAt,
        runId: ev.runId,
      })
    } else if (ev.type === 'unclaim') {
      const existing = byId.get(ev.id)
      if (!existing) continue
      byId.set(ev.id, {
        ...existing,
        state: 'queued',
        claimedBy: undefined,
        claimedAt: undefined,
        runId: undefined,
      })
    } else if (ev.type === 'done') {
      const existing = byId.get(ev.id)
      if (!existing) continue
      byId.set(ev.id, {
        ...existing,
        state: 'done',
        completedAt: ev.completedAt,
        runId: ev.runId,
      })
    } else if (ev.type === 'failed') {
      const existing = byId.get(ev.id)
      if (!existing) continue
      byId.set(ev.id, {
        ...existing,
        state: 'failed',
        failedAt: ev.failedAt,
        runId: ev.runId,
        error: ev.error,
      })
    }
  }

  const state: QueueState = { queued: [], claimed: [], done: [], failed: [] }
  for (const item of byId.values()) {
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
async function legacyEnqueueItems<T>(
  workflow: string,
  inputs: T[],
  idFn: (input: T, index: number) => string,
  trackerDir?: string,
  preAssignedRunIds?: ReadonlyArray<UUID>,
  preAssignedParentRunIds?: ReadonlyArray<string | undefined>,
): Promise<Array<{ id: string; position: number; runId: UUID }>> {
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
  const enqueuedBy = `cli-${process.pid}`
  const assigned: Array<{ id: string; runId: UUID }> = []
  for (let i = 0; i < inputs.length; i++) {
    const id = idFn(inputs[i], i)
    const runId = preAssignedRunIds?.[i] ?? randomUUID()
    const parentRunId = preAssignedParentRunIds?.[i]
    assigned.push({ id, runId })
    appendEvent(
      workflow,
      {
        type: 'enqueue',
        id,
        workflow,
        input: inputs[i],
        enqueuedAt: nowIso(),
        enqueuedBy,
        runId,
        ...(parentRunId ? { parentRunId } : {}),
      },
      trackerDir,
    )
  }
  // Position computation: fold and find each id's position in queued[].
  const state = await legacyReadQueueState(workflow, trackerDir)
  const queuedIds = state.queued.map((q) => q.id)
  return assigned.map(({ id, runId }) => {
    const idx = queuedIds.indexOf(id)
    return { id, position: idx >= 0 ? idx + 1 : 0, runId }
  })
}

/**
 * Total wall time acceptable when contending for the claim mutex: ~3s.
 * 20 attempts with exponential backoff capped at 100ms per sleep + ±30% jitter.
 * In normal operation the mutex is held for single-digit milliseconds; 20
 * retries handles a fleet of 8+ daemons all racing.
 */
const CLAIM_RETRY_COUNT = 20
const CLAIM_BASE_BACKOFF_MS = 1
const CLAIM_MAX_BACKOFF_MS = 100

/** Mutex considered stale if its directory mtime is this old without a release. */
const STALE_MUTEX_AGE_MS = 5000

function jitteredSleep(base: number): Promise<void> {
  const jitter = 1 + (Math.random() - 0.5) * 0.6 // ±30%
  const ms = Math.max(1, Math.round(base * jitter))
  return new Promise((r) => setTimeout(r, ms))
}

async function acquireMutex(lockDir: string): Promise<void> {
  let backoff = CLAIM_BASE_BACKOFF_MS
  for (let attempt = 0; attempt < CLAIM_RETRY_COUNT; attempt++) {
    try {
      mkdirSync(lockDir)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err
      // Stale-mutex defense: if the dir's mtime is older than the stale
      // threshold, try force-removing it and retry. Benign if concurrent
      // removal races.
      try {
        const st = statSync(lockDir)
        if (Date.now() - st.mtimeMs > STALE_MUTEX_AGE_MS) {
          try {
            rmdirSync(lockDir)
          } catch {
            /* concurrent removal is fine */
          }
          continue // retry immediately after cleanup
        }
      } catch {
        /* statSync may fail if the dir was just removed — loop retries */
      }
      await jitteredSleep(backoff)
      backoff = Math.min(CLAIM_MAX_BACKOFF_MS, backoff * 2)
    }
  }
  throw new Error(
    `daemon-queue: could not acquire claim mutex ${lockDir} after ${CLAIM_RETRY_COUNT} attempts`,
  )
}

function releaseMutex(lockDir: string): void {
  try {
    rmdirSync(lockDir)
  } catch {
    /* already removed / never existed — benign */
  }
}

/**
 * Atomically claim the next queued item for `instanceId`. Held mutex during
 * the read-modify-write: read queue, find first `queued` entry, append a
 * `claim` event, release mutex. Returns the claimed item (with freshly-
 * generated runId populated) or null if no queued items exist.
 *
 * Exclusivity is guaranteed across process boundaries by the directory-
 * mutex; N daemons racing for 1 queued item → exactly 1 claim appended,
 * N-1 calls return null.
 */
async function legacyClaimNextItem(
  workflow: string,
  instanceId: string,
  trackerDir?: string,
): Promise<QueueItem | null> {
  ensureDaemonsDir(trackerDir)
  const lockDir = queueLockDirPath(workflow, trackerDir)
  await acquireMutex(lockDir)
  try {
    const state = await legacyReadQueueState(workflow, trackerDir)
    if (state.queued.length === 0) return null
    const next = state.queued[0]
    // Reuse the enqueue-time runId if one was pre-assigned (see
    // `enqueueItems`) so the caller's pre-emitted `pending` tracker row
    // pairs 1:1 with the downstream running/done rows. Fall back to a
    // fresh UUID for enqueue events written before the pre-assignment
    // feature landed (backward-compat with older queue.jsonl files).
    const runId = next.runId ?? randomUUID()
    const claimedAt = nowIso()
    appendEvent(
      workflow,
      { type: 'claim', id: next.id, claimedBy: instanceId, claimedAt, runId },
      trackerDir,
    )
    return {
      ...next,
      state: 'claimed',
      claimedBy: instanceId,
      claimedAt,
      runId,
    }
  } finally {
    releaseMutex(lockDir)
  }
}

/** Append a `done` event. Caller must have previously claimed the item. */
async function legacyMarkItemDone(
  workflow: string,
  itemId: string,
  runId: string,
  trackerDir?: string,
): Promise<void> {
  appendEvent(workflow, { type: 'done', id: itemId, completedAt: nowIso(), runId }, trackerDir)
}

/** Append a `failed` event. Caller must have previously claimed the item. */
async function legacyMarkItemFailed(
  workflow: string,
  itemId: string,
  error: string,
  runId: string,
  trackerDir?: string,
): Promise<void> {
  appendEvent(
    workflow,
    { type: 'failed', id: itemId, failedAt: nowIso(), runId, error },
    trackerDir,
  )
}

/**
 * Re-queue a claimed item by appending an `unclaim` event. Used for SIGINT
 * soft-stop (reason='sigint-soft'), voluntary release (reason='voluntary'),
 * and orphan recovery (reason='recovered').
 */
async function legacyUnclaimItem(
  workflow: string,
  itemId: string,
  reason: 'recovered' | 'sigint-soft' | 'voluntary',
  trackerDir?: string,
): Promise<void> {
  appendEvent(workflow, { type: 'unclaim', id: itemId, reason, ts: nowIso() }, trackerDir)
}

/**
 * Scan current state; for each `claimed` item whose `claimedBy` is NOT in
 * the alive set, append an `unclaim(reason: 'recovered')`. Returns the
 * count recovered. Runs without the mutex — appends are atomic, and the
 * fold is idempotent so a race with a legitimate daemon that re-claims
 * between our read and our unclaim just appears as a later-wins
 * unclaim → legitimate re-claim sequence (worst case: one redundant
 * unclaim, never a lost item).
 */
async function legacyRecoverOrphanedClaims(
  workflow: string,
  aliveInstanceIds: Set<string>,
  trackerDir?: string,
): Promise<number> {
  const state = await legacyReadQueueState(workflow, trackerDir)
  let count = 0
  for (const item of state.claimed) {
    if (!item.claimedBy) continue
    if (!aliveInstanceIds.has(item.claimedBy)) {
      await legacyUnclaimItem(workflow, item.id, 'recovered', trackerDir)
      count++
    }
  }
  return count
}

export async function readQueueState(workflow: string, trackerDir?: string): Promise<QueueState> {
  if (queueBackend() === 'jsonl') return legacyReadQueueState(workflow, trackerDir)
  const store = openQueueTaskStore(trackerDir)
  const state: QueueState = { queued: [], claimed: [], done: [], failed: [] }
  const rows = store.db.prepare(`
    SELECT id
    FROM tasks
    WHERE workflow = ?
      AND task_kind = 'workflow_item'
      AND source = 'daemon'
    ORDER BY COALESCE(enqueued_at, created_at) ASC, rowid ASC
  `).all(workflow) as Array<{ id: string }>
  for (const row of rows) {
    const task = store.getTask(row.id)
    if (!task) continue
    const item = taskToQueueItem(task)
    state[item.state].push(item)
  }
  return state
}

export async function enqueueItems<T>(
  workflow: string,
  inputs: T[],
  idFn: (input: T, index: number) => string,
  trackerDir?: string,
  preAssignedRunIds?: ReadonlyArray<UUID>,
  preAssignedParentRunIds?: ReadonlyArray<string | undefined>,
): Promise<Array<{ id: string; position: number; runId: UUID; taskId?: string; attemptId?: string }>> {
  if (queueBackend() === 'jsonl') {
    return legacyEnqueueItems(workflow, inputs, idFn, trackerDir, preAssignedRunIds, preAssignedParentRunIds)
  }
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
  const enqueued = store.enqueueTasks({
    workflow,
    inputs,
    deriveItemId: idFn,
    runIds: preAssignedRunIds,
    source: 'daemon',
  })
  const enqueuedBy = `cli-${process.pid}`
  for (let i = 0; i < enqueued.length; i++) {
    const task = enqueued[i]
    const parentRunId = preAssignedParentRunIds?.[i]
    // JSONL queue writes are audit-only in SQLite mode. Do not use them for claim authority.
    appendEvent(
      workflow,
      {
        type: 'enqueue',
        id: task.id,
        workflow,
        input: inputs[i],
        enqueuedAt: nowIso(),
        enqueuedBy,
        runId: task.runId,
        ...(parentRunId ? { parentRunId } : {}),
      },
      trackerDir,
    )
    if (parentRunId) {
      const row = store.findTaskByIdentity({ workflow, itemId: task.id, runId: task.runId })
      if (row) {
        store.db.prepare('UPDATE tasks SET parent_run_id = ? WHERE id = ?').run(parentRunId, row.taskId)
      }
    }
  }
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
  if (queueBackend() === 'jsonl') return legacyClaimNextItem(workflow, instanceId, trackerDir)
  const store = openQueueTaskStore(trackerDir)
  const claimed = store.claimNextTask({ workflow, workerId: instanceId })
  if (!claimed) return null
  appendEvent(
    workflow,
    { type: 'claim', id: claimed.itemId, claimedBy: instanceId, claimedAt: nowIso(), runId: claimed.runId },
    trackerDir,
  )
  return {
    id: claimed.itemId,
    workflow,
    input: claimed.input,
    enqueuedAt: nowIso(),
    state: 'claimed',
    taskId: claimed.taskId,
    attemptId: claimed.attemptId,
    claimedBy: instanceId,
    claimedAt: nowIso(),
    runId: claimed.runId,
    ...(claimed.parentRunId ? { parentRunId: claimed.parentRunId } : {}),
  }
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
  const task = store.findTaskByIdentity({ workflow, itemId, runId })
  const attemptId = task ? resolveCurrentAttemptId(store, task, runId) : undefined

  if (task) {
    if (status === 'done') {
      if (attemptId) store.markTaskDone({ taskId: task.taskId, attemptId })
      else markTaskTerminalWithoutAttempt(store, task.taskId, 'done')
    } else if (status === 'failed') {
      if (attemptId) store.markTaskFailed({ taskId: task.taskId, attemptId, error: payload.error ?? '' })
      else markTaskTerminalWithoutAttempt(store, task.taskId, 'failed', payload.error)
    } else {
      store.markTaskCancelled({
        taskId: task.taskId,
        ...(attemptId ? { attemptId } : {}),
        reason: payload.reason ?? '',
      })
    }
  }

  if (status === 'done') {
    appendEvent(workflow, { type: 'done', id: itemId, completedAt: nowIso(), runId }, trackerDir)
  } else {
    const error = status === 'failed' ? (payload.error ?? '') : (payload.reason ?? '')
    appendEvent(workflow, { type: 'failed', id: itemId, failedAt: nowIso(), runId, error }, trackerDir)
  }
}

export async function markItemDone(
  workflow: string,
  itemId: string,
  runId: string,
  trackerDir?: string,
): Promise<void> {
  if (queueBackend() === 'jsonl') return legacyMarkItemDone(workflow, itemId, runId, trackerDir)
  return markTaskTerminal(workflow, itemId, runId, 'done', {}, trackerDir)
}

export async function markItemFailed(
  workflow: string,
  itemId: string,
  error: string,
  runId: string,
  trackerDir?: string,
): Promise<void> {
  if (queueBackend() === 'jsonl') return legacyMarkItemFailed(workflow, itemId, error, runId, trackerDir)
  return markTaskTerminal(workflow, itemId, runId, 'failed', { error }, trackerDir)
}

export async function markItemCancelled(
  workflow: string,
  itemId: string,
  reason: string,
  runId: string,
  trackerDir?: string,
): Promise<void> {
  if (queueBackend() === 'jsonl') return legacyMarkItemFailed(workflow, itemId, reason, runId, trackerDir)
  return markTaskTerminal(workflow, itemId, runId, 'cancelled', { reason }, trackerDir)
}

export async function unclaimItem(
  workflow: string,
  itemId: string,
  reason: 'recovered' | 'sigint-soft' | 'voluntary',
  trackerDir?: string,
  runId?: string,
): Promise<void> {
  if (queueBackend() === 'jsonl') return legacyUnclaimItem(workflow, itemId, reason, trackerDir)
  const store = openQueueTaskStore(trackerDir)
  const task = store.findTaskByIdentity({ workflow, itemId, ...(runId ? { runId } : {}) })
  if (task) store.returnTaskToQueued({ taskId: task.taskId })
  appendEvent(workflow, { type: 'unclaim', id: itemId, reason, ts: nowIso() }, trackerDir)
}

export async function recoverOrphanedClaims(
  workflow: string,
  aliveInstanceIds: Set<string>,
  trackerDir?: string,
): Promise<number> {
  if (queueBackend() === 'jsonl') return legacyRecoverOrphanedClaims(workflow, aliveInstanceIds, trackerDir)
  const store = openQueueTaskStore(trackerDir)
  const recovered = store.recoverClaimsForDeadWorkers({ workflow, aliveWorkerIds: aliveInstanceIds })
  if (recovered > 0) {
    const state = await readQueueState(workflow, trackerDir)
    for (const item of state.queued) {
      if (item.claimedBy && !aliveInstanceIds.has(item.claimedBy)) {
        appendEvent(workflow, { type: 'unclaim', id: item.id, reason: 'recovered', ts: nowIso() }, trackerDir)
      }
    }
  }
  return recovered
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
  `).run({ taskId: task.taskId, attemptId: row.id, now: nowIso() })
  return row.id
}

function markTaskTerminalWithoutAttempt(
  store: ReturnType<typeof openQueueTaskStore>,
  taskId: string,
  state: 'done' | 'failed',
  error?: string,
): void {
  const now = nowIso()
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
