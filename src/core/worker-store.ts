import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

import type { ControlDb } from './control-db.js'

export type WorkerKind = 'daemon' | 'dashboard' | 'pool' | 'shared_context_pool'
export type WorkerStatus = 'starting' | 'alive' | 'draining' | 'stopped' | 'dead' | 'stale'
export type WorkerCommandType =
  | 'cancel_task'
  | 'retry_task'
  | 'drain_worker'
  | 'stop_worker'
  | 'force_stop_task'
  | 'kill_browser'
  | 'force_kill_worker'
  | 'health_check'
export type WorkerCommandState = 'queued' | 'acknowledged' | 'completed' | 'failed' | 'cancelled'
export type BrowserProcessStatus = 'launched' | 'alive' | 'kill_requested' | 'terminated' | 'lost'

export interface WorkerRow {
  workerId: string
  workflow?: string
  kind: WorkerKind
  pid: number
  parentPid?: number
  hostname: string
  port?: number
  instanceId?: string
  lockfilePath?: string
  phase: string
  status: WorkerStatus
  currentTaskId?: string
  currentAttemptId?: string
  startedAt: string
  stoppedAt?: string
  lastHeartbeatAt?: string
  heartbeatTtlMs: number
  metadata: Record<string, unknown>
}

export interface WorkerCommandRow {
  commandId: string
  commandType: WorkerCommandType
  state: WorkerCommandState
  workflow?: string
  targetWorkerId?: string
  targetTaskId?: string
  targetAttemptId?: string
  targetBrowserProcessId?: string
  requestedBy: string
  requestedAt: string
  acknowledgedAt?: string
  completedAt?: string
  error?: string
  payload: Record<string, unknown>
}

export interface BrowserProcessRow {
  browserProcessId: string
  workerId: string
  workflow?: string
  taskId?: string
  attemptId?: string
  systemId: string
  browserId: string
  pid: number
  sessionDir?: string
  status: BrowserProcessStatus
  launchedAt: string
  lastSeenAt?: string
  terminatedAt?: string
  killCommandId?: string
  metadata: Record<string, unknown>
}

export interface ControlWorkerStore {
  control: ControlDb
  db: Database.Database
  close(): void
  registerWorker(request: RegisterWorkerRequest): WorkerRow
  heartbeatWorker(request: HeartbeatWorkerRequest): void
  getWorker(workerId: string): WorkerRow | null
  listWorkers(workflow?: string): WorkerRow[]
  listHeartbeats(workerId: string): Array<{ heartbeatId: string; workerId: string; ts: string; phase: string }>
  listStaleWorkers(request: { now?: string }): WorkerRow[]
  markWorkerStatus(request: { workerId: string; status: WorkerStatus; phase?: string; now?: string }): void
  enqueueWorkerCommand(request: EnqueueWorkerCommandRequest): string
  listQueuedCommandsForWorker(workerId: string): WorkerCommandRow[]
  getCommand(commandId: string): WorkerCommandRow | null
  acknowledgeCommand(commandId: string, workerId: string, now?: string): void
  completeCommand(commandId: string, now?: string): void
  failCommand(commandId: string, error: string, now?: string): void
  upsertBrowserProcess(request: UpsertBrowserProcessRequest): BrowserProcessRow
  markBrowserProcessSeen(request: { browserProcessId: string; now?: string }): void
  markBrowserProcessKillRequested(request: { browserProcessId: string; commandId: string; now?: string }): void
  markBrowserProcessTerminated(request: { browserProcessId: string; now?: string }): void
  markBrowserProcessLost(request: { browserProcessId: string; now?: string }): void
  listBrowserProcessesForWorker(workerId: string): BrowserProcessRow[]
  listBrowserProcessesForTask(request: { taskId?: string; attemptId?: string }): BrowserProcessRow[]
  findBrowserProcessByPid(pid: number): BrowserProcessRow | null
  findBrowserProcessById(browserProcessId: string): BrowserProcessRow | null
  findWorkerOwnerByTask(request: { taskId?: string; attemptId?: string }): WorkerRow | null
}

export interface RegisterWorkerRequest {
  workerId: string
  workflow?: string
  kind: WorkerKind
  pid: number
  parentPid?: number
  hostname: string
  port?: number
  instanceId?: string
  lockfilePath?: string
  phase: string
  status?: WorkerStatus
  heartbeatTtlMs?: number
  metadata?: Record<string, unknown>
  now?: string
}

export interface HeartbeatWorkerRequest {
  workerId: string
  phase: string
  currentTaskId?: string | null
  currentAttemptId?: string | null
  queueDepth?: number
  payload?: Record<string, unknown>
  now?: string
}

export interface EnqueueWorkerCommandRequest {
  commandType: WorkerCommandType
  workflow?: string
  targetWorkerId?: string
  targetTaskId?: string
  targetAttemptId?: string
  targetBrowserProcessId?: string
  requestedBy?: string
  payload?: Record<string, unknown>
  state?: WorkerCommandState
  now?: string
}

export interface UpsertBrowserProcessRequest {
  workerId: string
  workflow?: string
  taskId?: string
  attemptId?: string
  systemId: string
  browserId: string
  pid: number
  sessionDir?: string
  status?: BrowserProcessStatus
  metadata?: Record<string, unknown>
  now?: string
}

interface WorkerDbRow {
  worker_id: string
  workflow: string | null
  kind: WorkerKind
  pid: number
  parent_pid: number | null
  hostname: string
  port: number | null
  instance_id: string | null
  lockfile_path: string | null
  phase: string
  status: WorkerStatus
  current_task_id: string | null
  current_attempt_id: string | null
  started_at: string
  stopped_at: string | null
  last_heartbeat_at: string | null
  heartbeat_ttl_ms: number
  metadata_json: string | null
}

interface WorkerCommandDbRow {
  command_id: string
  command_type: WorkerCommandType
  state: WorkerCommandState
  workflow: string | null
  target_worker_id: string | null
  target_task_id: string | null
  target_attempt_id: string | null
  target_browser_process_id: string | null
  requested_by: string
  requested_at: string
  acknowledged_at: string | null
  completed_at: string | null
  error: string | null
  payload_json: string | null
}

interface BrowserProcessDbRow {
  browser_process_id: string
  worker_id: string
  workflow: string | null
  task_id: string | null
  attempt_id: string | null
  system_id: string
  browser_id: string
  pid: number
  session_dir: string | null
  status: BrowserProcessStatus
  launched_at: string
  last_seen_at: string | null
  terminated_at: string | null
  kill_command_id: string | null
  metadata_json: string | null
}

export function createWorkerStore(control: ControlDb): ControlWorkerStore {
  const db = control.db
  return {
    control,
    db,
    close: () => control.close(),
    registerWorker: (request) => registerWorker(db, control, request),
    heartbeatWorker: (request) => heartbeatWorker(db, control, request),
    getWorker: (workerId) => {
      const row = db.prepare('SELECT * FROM workers WHERE worker_id = ?').get(workerId) as WorkerDbRow | undefined
      return row ? mapWorkerRow(row) : null
    },
    listWorkers: (workflow) => listWorkers(db, workflow),
    listHeartbeats: (workerId) => db.prepare(`
      SELECT heartbeat_id AS heartbeatId, worker_id AS workerId, ts, phase
      FROM worker_heartbeats
      WHERE worker_id = ?
      ORDER BY ts DESC
    `).all(workerId) as Array<{ heartbeatId: string; workerId: string; ts: string; phase: string }>,
    listStaleWorkers: (request) => listStaleWorkers(db, request.now ?? new Date().toISOString()),
    markWorkerStatus: (request) => markWorkerStatus(db, control, request),
    enqueueWorkerCommand: (request) => enqueueWorkerCommand(db, control, request),
    listQueuedCommandsForWorker: (workerId) => listQueuedCommandsForWorker(db, workerId),
    getCommand: (commandId) => {
      const row = db.prepare('SELECT * FROM worker_commands WHERE command_id = ?').get(commandId) as WorkerCommandDbRow | undefined
      return row ? mapCommandRow(row) : null
    },
    acknowledgeCommand: (commandId, workerId, now) => acknowledgeCommand(db, control, commandId, workerId, now),
    completeCommand: (commandId, now) => completeCommand(db, control, commandId, now),
    failCommand: (commandId, error, now) => failCommand(db, control, commandId, error, now),
    upsertBrowserProcess: (request) => upsertBrowserProcess(db, control, request),
    markBrowserProcessSeen: (request) => markBrowserProcessSeen(db, control, request),
    markBrowserProcessKillRequested: (request) => markBrowserProcessKillRequested(db, control, request),
    markBrowserProcessTerminated: (request) => markBrowserProcessTerminal(db, control, request.browserProcessId, 'terminated', request.now),
    markBrowserProcessLost: (request) => markBrowserProcessTerminal(db, control, request.browserProcessId, 'lost', request.now),
    listBrowserProcessesForWorker: (workerId) => {
      const rows = db.prepare(`
        SELECT *
        FROM browser_processes
        WHERE worker_id = ?
        ORDER BY system_id ASC, pid ASC
      `).all(workerId) as BrowserProcessDbRow[]
      return rows.map(mapBrowserProcessRow)
    },
    listBrowserProcessesForTask: (request) => listBrowserProcessesForTask(db, request),
    findBrowserProcessByPid: (pid) => {
      const row = db.prepare(`
        SELECT *
        FROM browser_processes
        WHERE pid = ?
        ORDER BY last_seen_at DESC, launched_at DESC
        LIMIT 1
      `).get(pid) as BrowserProcessDbRow | undefined
      return row ? mapBrowserProcessRow(row) : null
    },
    findBrowserProcessById: (browserProcessId) => {
      const row = db.prepare('SELECT * FROM browser_processes WHERE browser_process_id = ?').get(browserProcessId) as
        | BrowserProcessDbRow
        | undefined
      return row ? mapBrowserProcessRow(row) : null
    },
    findWorkerOwnerByTask: (request) => findWorkerOwnerByTask(db, request),
  }
}

function registerWorker(db: Database.Database, control: ControlDb, request: RegisterWorkerRequest): WorkerRow {
  const now = request.now ?? new Date().toISOString()
  control.transaction(() => {
    db.prepare(`
      INSERT INTO workers (
        worker_id, workflow, kind, pid, parent_pid, hostname, port, instance_id,
        lockfile_path, phase, status, current_task_id, current_attempt_id,
        started_at, stopped_at, last_heartbeat_at, heartbeat_ttl_ms, metadata_json
      ) VALUES (
        @workerId, @workflow, @kind, @pid, @parentPid, @hostname, @port, @instanceId,
        @lockfilePath, @phase, @status, NULL, NULL,
        @now, NULL, @now, @heartbeatTtlMs, @metadataJson
      )
      ON CONFLICT(worker_id) DO UPDATE SET
        workflow = excluded.workflow,
        kind = excluded.kind,
        pid = excluded.pid,
        parent_pid = excluded.parent_pid,
        hostname = excluded.hostname,
        port = excluded.port,
        instance_id = excluded.instance_id,
        lockfile_path = excluded.lockfile_path,
        phase = excluded.phase,
        status = excluded.status,
        stopped_at = NULL,
        last_heartbeat_at = excluded.last_heartbeat_at,
        heartbeat_ttl_ms = excluded.heartbeat_ttl_ms,
        metadata_json = excluded.metadata_json
    `).run({
      workerId: request.workerId,
      workflow: request.workflow ?? null,
      kind: request.kind,
      pid: request.pid,
      parentPid: request.parentPid ?? null,
      hostname: request.hostname,
      port: request.port ?? null,
      instanceId: request.instanceId ?? null,
      lockfilePath: request.lockfilePath ?? null,
      phase: request.phase,
      status: request.status ?? 'alive',
      heartbeatTtlMs: request.heartbeatTtlMs ?? 30_000,
      metadataJson: JSON.stringify(request.metadata ?? {}),
      now,
    })
  })
  return requireWorker(db, request.workerId)
}

function heartbeatWorker(db: Database.Database, control: ControlDb, request: HeartbeatWorkerRequest): void {
  const now = request.now ?? new Date().toISOString()
  const cutoff = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString()
  control.transaction(() => {
    db.prepare(`
      UPDATE workers
      SET phase = @phase,
          status = CASE WHEN status = 'draining' THEN 'draining' ELSE 'alive' END,
          current_task_id = @currentTaskId,
          current_attempt_id = @currentAttemptId,
          last_heartbeat_at = @now
      WHERE worker_id = @workerId
    `).run({
      workerId: request.workerId,
      phase: request.phase,
      currentTaskId: request.currentTaskId ?? null,
      currentAttemptId: request.currentAttemptId ?? null,
      now,
    })
    db.prepare(`
      INSERT INTO worker_heartbeats (
        heartbeat_id, worker_id, ts, phase, current_task_id,
        current_attempt_id, queue_depth, payload_json
      ) VALUES (
        @heartbeatId, @workerId, @now, @phase, @currentTaskId,
        @currentAttemptId, @queueDepth, @payloadJson
      )
    `).run({
      heartbeatId: randomUUID(),
      workerId: request.workerId,
      now,
      phase: request.phase,
      currentTaskId: request.currentTaskId ?? null,
      currentAttemptId: request.currentAttemptId ?? null,
      queueDepth: request.queueDepth ?? null,
      payloadJson: JSON.stringify(request.payload ?? {}),
    })
    db.prepare(`
      DELETE FROM worker_heartbeats
      WHERE worker_id = @workerId AND ts < @cutoff
    `).run({ workerId: request.workerId, cutoff })
  })
}

function listStaleWorkers(db: Database.Database, now: string): WorkerRow[] {
  const rows = db.prepare(`
    SELECT *
    FROM workers
    WHERE status IN ('starting', 'alive', 'draining')
  `).all() as WorkerDbRow[]
  const nowMs = Date.parse(now)
  return rows
    .filter((row) => {
      const anchor = row.last_heartbeat_at ?? row.started_at
      return Date.parse(anchor) + row.heartbeat_ttl_ms < nowMs
    })
    .map(mapWorkerRow)
}

function markWorkerStatus(
  db: Database.Database,
  control: ControlDb,
  request: { workerId: string; status: WorkerStatus; phase?: string; now?: string },
): void {
  const now = request.now ?? new Date().toISOString()
  control.transaction(() => {
    db.prepare(`
      UPDATE workers
      SET status = @status,
          phase = COALESCE(@phase, phase),
          current_task_id = CASE
            WHEN @status IN ('stopped', 'dead', 'stale') THEN NULL
            ELSE current_task_id
          END,
          current_attempt_id = CASE
            WHEN @status IN ('stopped', 'dead', 'stale') THEN NULL
            ELSE current_attempt_id
          END,
          stopped_at = CASE
            WHEN @status IN ('stopped', 'dead', 'stale') THEN COALESCE(stopped_at, @now)
            ELSE stopped_at
          END
      WHERE worker_id = @workerId
    `).run({ workerId: request.workerId, status: request.status, phase: request.phase ?? null, now })
  })
}

function enqueueWorkerCommand(db: Database.Database, control: ControlDb, request: EnqueueWorkerCommandRequest): string {
  const now = request.now ?? new Date().toISOString()
  const commandId = randomUUID()
  control.transaction(() => {
    db.prepare(`
      INSERT INTO worker_commands (
        command_id, command_type, state, workflow, target_worker_id,
        target_task_id, target_attempt_id, target_browser_process_id,
        requested_by, requested_at, payload_json
      ) VALUES (
        @commandId, @commandType, @state, @workflow, @targetWorkerId,
        @targetTaskId, @targetAttemptId, @targetBrowserProcessId,
        @requestedBy, @now, @payloadJson
      )
    `).run({
      commandId,
      commandType: request.commandType,
      state: request.state ?? 'queued',
      workflow: request.workflow ?? null,
      targetWorkerId: request.targetWorkerId ?? null,
      targetTaskId: request.targetTaskId ?? null,
      targetAttemptId: request.targetAttemptId ?? null,
      targetBrowserProcessId: request.targetBrowserProcessId ?? null,
      requestedBy: request.requestedBy ?? 'dashboard',
      payloadJson: JSON.stringify(request.payload ?? {}),
      now,
    })
  })
  return commandId
}

function listQueuedCommandsForWorker(db: Database.Database, workerId: string): WorkerCommandRow[] {
  const rows = db.prepare(`
    SELECT *
    FROM worker_commands
    WHERE target_worker_id = ?
      AND state = 'queued'
    ORDER BY requested_at ASC, rowid ASC
  `).all(workerId) as WorkerCommandDbRow[]
  return rows.map(mapCommandRow)
}

function acknowledgeCommand(db: Database.Database, control: ControlDb, commandId: string, workerId: string, now?: string): void {
  const ts = now ?? new Date().toISOString()
  control.transaction(() => {
    db.prepare(`
      UPDATE worker_commands
      SET state = 'acknowledged',
          acknowledged_at = @ts
      WHERE command_id = @commandId
        AND state = 'queued'
        AND (target_worker_id IS NULL OR target_worker_id = @workerId)
    `).run({ commandId, workerId, ts })
  })
}

function completeCommand(db: Database.Database, control: ControlDb, commandId: string, now?: string): void {
  const ts = now ?? new Date().toISOString()
  control.transaction(() => {
    db.prepare(`
      UPDATE worker_commands
      SET state = 'completed',
          completed_at = @ts
      WHERE command_id = @commandId
    `).run({ commandId, ts })
  })
}

function failCommand(db: Database.Database, control: ControlDb, commandId: string, error: string, now?: string): void {
  const ts = now ?? new Date().toISOString()
  control.transaction(() => {
    db.prepare(`
      UPDATE worker_commands
      SET state = 'failed',
          completed_at = @ts,
          error = @error
      WHERE command_id = @commandId
    `).run({ commandId, error, ts })
  })
}

function upsertBrowserProcess(
  db: Database.Database,
  control: ControlDb,
  request: UpsertBrowserProcessRequest,
): BrowserProcessRow {
  const now = request.now ?? new Date().toISOString()
  control.transaction(() => {
    db.prepare(`
      INSERT INTO browser_processes (
        browser_process_id, worker_id, workflow, task_id, attempt_id,
        system_id, browser_id, pid, session_dir, status, launched_at,
        last_seen_at, terminated_at, kill_command_id, metadata_json
      ) VALUES (
        @browserProcessId, @workerId, @workflow, @taskId, @attemptId,
        @systemId, @browserId, @pid, @sessionDir, @status, @now,
        @now, NULL, NULL, @metadataJson
      )
      ON CONFLICT(worker_id, system_id, pid) DO UPDATE SET
        workflow = excluded.workflow,
        task_id = excluded.task_id,
        attempt_id = excluded.attempt_id,
        browser_id = excluded.browser_id,
        session_dir = excluded.session_dir,
        status = CASE
          WHEN browser_processes.status IN ('terminated', 'lost') THEN browser_processes.status
          ELSE excluded.status
        END,
        last_seen_at = excluded.last_seen_at,
        metadata_json = excluded.metadata_json
    `).run({
      browserProcessId: randomUUID(),
      workerId: request.workerId,
      workflow: request.workflow ?? null,
      taskId: request.taskId ?? null,
      attemptId: request.attemptId ?? null,
      systemId: request.systemId,
      browserId: request.browserId,
      pid: request.pid,
      sessionDir: request.sessionDir ?? null,
      status: request.status ?? 'alive',
      metadataJson: JSON.stringify(request.metadata ?? {}),
      now,
    })
  })
  const row = db.prepare(`
    SELECT *
    FROM browser_processes
    WHERE worker_id = @workerId AND system_id = @systemId AND pid = @pid
  `).get(request) as BrowserProcessDbRow
  return mapBrowserProcessRow(row)
}

function markBrowserProcessSeen(
  db: Database.Database,
  control: ControlDb,
  request: { browserProcessId: string; now?: string },
): void {
  const now = request.now ?? new Date().toISOString()
  control.transaction(() => {
    db.prepare(`
      UPDATE browser_processes
      SET last_seen_at = @now,
          status = CASE WHEN status = 'launched' THEN 'alive' ELSE status END
      WHERE browser_process_id = @browserProcessId
    `).run({ browserProcessId: request.browserProcessId, now })
  })
}

function markBrowserProcessKillRequested(
  db: Database.Database,
  control: ControlDb,
  request: { browserProcessId: string; commandId: string; now?: string },
): void {
  const now = request.now ?? new Date().toISOString()
  control.transaction(() => {
    db.prepare(`
      UPDATE browser_processes
      SET status = 'kill_requested',
          kill_command_id = @commandId,
          last_seen_at = @now
      WHERE browser_process_id = @browserProcessId
    `).run({ browserProcessId: request.browserProcessId, commandId: request.commandId, now })
  })
}

function markBrowserProcessTerminal(
  db: Database.Database,
  control: ControlDb,
  browserProcessId: string,
  status: Extract<BrowserProcessStatus, 'terminated' | 'lost'>,
  now?: string,
): void {
  const ts = now ?? new Date().toISOString()
  control.transaction(() => {
    db.prepare(`
      UPDATE browser_processes
      SET status = @status,
          terminated_at = COALESCE(terminated_at, @ts),
          last_seen_at = @ts
      WHERE browser_process_id = @browserProcessId
    `).run({ browserProcessId, status, ts })
  })
}

function listBrowserProcessesForTask(
  db: Database.Database,
  request: { taskId?: string; attemptId?: string },
): BrowserProcessRow[] {
  const rows = db.prepare(`
    SELECT *
    FROM browser_processes
    WHERE (@taskId IS NOT NULL AND task_id = @taskId)
       OR (@attemptId IS NOT NULL AND attempt_id = @attemptId)
    ORDER BY system_id ASC, pid ASC
  `).all({ taskId: request.taskId ?? null, attemptId: request.attemptId ?? null }) as BrowserProcessDbRow[]
  return rows.map(mapBrowserProcessRow)
}

function findWorkerOwnerByTask(
  db: Database.Database,
  request: { taskId?: string; attemptId?: string },
): WorkerRow | null {
  const row = db.prepare(`
    SELECT w.*
    FROM workers w
    LEFT JOIN task_attempts a ON a.worker_id = w.worker_id
    WHERE (@taskId IS NOT NULL AND w.current_task_id = @taskId)
       OR (@attemptId IS NOT NULL AND w.current_attempt_id = @attemptId)
       OR (@attemptId IS NOT NULL AND a.id = @attemptId)
    ORDER BY w.last_heartbeat_at DESC
    LIMIT 1
  `).get({ taskId: request.taskId ?? null, attemptId: request.attemptId ?? null }) as WorkerDbRow | undefined
  return row ? mapWorkerRow(row) : null
}

function listWorkers(db: Database.Database, workflow?: string): WorkerRow[] {
  const rows = workflow
    ? db.prepare(`
        SELECT *
        FROM workers
        WHERE workflow = ?
        ORDER BY started_at ASC
      `).all(workflow) as WorkerDbRow[]
    : db.prepare(`
        SELECT *
        FROM workers
        ORDER BY started_at ASC
      `).all() as WorkerDbRow[]
  return rows.map(mapWorkerRow)
}

function requireWorker(db: Database.Database, workerId: string): WorkerRow {
  const row = db.prepare('SELECT * FROM workers WHERE worker_id = ?').get(workerId) as WorkerDbRow | undefined
  if (!row) throw new Error(`Worker ${workerId} not found after registration`)
  return mapWorkerRow(row)
}

function mapWorkerRow(row: WorkerDbRow): WorkerRow {
  const worker: WorkerRow = {
    workerId: row.worker_id,
    kind: row.kind,
    pid: row.pid,
    hostname: row.hostname,
    phase: row.phase,
    status: row.status,
    startedAt: row.started_at,
    heartbeatTtlMs: row.heartbeat_ttl_ms,
    metadata: parseJsonObject(row.metadata_json),
  }
  if (row.workflow) worker.workflow = row.workflow
  if (row.parent_pid !== null) worker.parentPid = row.parent_pid
  if (row.port !== null) worker.port = row.port
  if (row.instance_id) worker.instanceId = row.instance_id
  if (row.lockfile_path) worker.lockfilePath = row.lockfile_path
  if (row.current_task_id) worker.currentTaskId = row.current_task_id
  if (row.current_attempt_id) worker.currentAttemptId = row.current_attempt_id
  if (row.stopped_at) worker.stoppedAt = row.stopped_at
  if (row.last_heartbeat_at) worker.lastHeartbeatAt = row.last_heartbeat_at
  return worker
}

function mapCommandRow(row: WorkerCommandDbRow): WorkerCommandRow {
  const command: WorkerCommandRow = {
    commandId: row.command_id,
    commandType: row.command_type,
    state: row.state,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    payload: parseJsonObject(row.payload_json),
  }
  if (row.workflow) command.workflow = row.workflow
  if (row.target_worker_id) command.targetWorkerId = row.target_worker_id
  if (row.target_task_id) command.targetTaskId = row.target_task_id
  if (row.target_attempt_id) command.targetAttemptId = row.target_attempt_id
  if (row.target_browser_process_id) command.targetBrowserProcessId = row.target_browser_process_id
  if (row.acknowledged_at) command.acknowledgedAt = row.acknowledged_at
  if (row.completed_at) command.completedAt = row.completed_at
  if (row.error) command.error = row.error
  return command
}

function mapBrowserProcessRow(row: BrowserProcessDbRow): BrowserProcessRow {
  const browser: BrowserProcessRow = {
    browserProcessId: row.browser_process_id,
    workerId: row.worker_id,
    systemId: row.system_id,
    browserId: row.browser_id,
    pid: row.pid,
    status: row.status,
    launchedAt: row.launched_at,
    metadata: parseJsonObject(row.metadata_json),
  }
  if (row.workflow) browser.workflow = row.workflow
  if (row.task_id) browser.taskId = row.task_id
  if (row.attempt_id) browser.attemptId = row.attempt_id
  if (row.session_dir) browser.sessionDir = row.session_dir
  if (row.last_seen_at) browser.lastSeenAt = row.last_seen_at
  if (row.terminated_at) browser.terminatedAt = row.terminated_at
  if (row.kill_command_id) browser.killCommandId = row.kill_command_id
  return browser
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}
