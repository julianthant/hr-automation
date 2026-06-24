export interface Migration {
  version: number;
  sql: string;
}

export const LATEST_SCHEMA_VERSION = 14;

export const MIGRATIONS: readonly Migration[] = [
  {
    // v6 baseline: complete schema from scratch.
    // Replaces migrations 1–6 which were collapsed after a full tracker wipe.
    // No backfills, no ALTER TABLE, no DROP COLUMN.
    // run_events.raw_json is NOT present (was dropped by old migration 6).
    // session_events.tracker_date IS present (was added by old migration 4).
    // tasks/task_attempts/task_dependencies include all v3 columns inline.
    version: 6,
    sql: String.raw`
CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projection_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('tracker', 'log', 'session')),
  workflow TEXT,
  tracker_date TEXT,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mtime_ms REAL NOT NULL DEFAULT 0,
  line_count INTEGER NOT NULL DEFAULT 0,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  rebuild_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE(source_kind, path)
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  source_offset INTEGER NOT NULL,
  workflow TEXT NOT NULL,
  tracker_date TEXT NOT NULL,
  item_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  parent_run_id TEXT,
  status TEXT NOT NULL,
  step TEXT,
  event_ts TEXT NOT NULL,
  event_ms INTEGER NOT NULL,
  data_json TEXT,
  typed_data_json TEXT,
  input_json TEXT,
  error TEXT,
  applied_at TEXT NOT NULL,
  UNIQUE(source_path, source_offset)
);

CREATE INDEX IF NOT EXISTS idx_run_events_workflow_date ON run_events(workflow, tracker_date, event_ms);
CREATE INDEX IF NOT EXISTS idx_run_events_item_run ON run_events(workflow, tracker_date, item_id, run_id, event_ms);
CREATE INDEX IF NOT EXISTS idx_run_events_parent ON run_events(parent_run_id);

CREATE TABLE IF NOT EXISTS runs (
  workflow TEXT NOT NULL,
  tracker_date TEXT NOT NULL,
  item_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  parent_run_id TEXT,
  first_any_ts TEXT NOT NULL,
  first_work_ts TEXT,
  latest_tracker_ts TEXT NOT NULL,
  latest_status TEXT NOT NULL,
  latest_step TEXT,
  latest_data_json TEXT,
  latest_typed_data_json TEXT,
  latest_input_json TEXT,
  latest_error TEXT,
  first_log_ts TEXT,
  last_log_ts TEXT,
  last_log_message TEXT,
  run_ordinal INTEGER NOT NULL DEFAULT 1,
  screenshot_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workflow, tracker_date, item_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_runs_workflow_date ON runs(workflow, tracker_date, first_work_ts, latest_tracker_ts);
CREATE INDEX IF NOT EXISTS idx_runs_latest_status ON runs(workflow, tracker_date, latest_status);
CREATE INDEX IF NOT EXISTS idx_runs_run_id ON runs(run_id);

CREATE TABLE IF NOT EXISTS items (
  workflow TEXT NOT NULL,
  tracker_date TEXT NOT NULL,
  item_id TEXT NOT NULL,
  latest_run_id TEXT NOT NULL,
  latest_status TEXT NOT NULL,
  latest_step TEXT,
  latest_ts TEXT NOT NULL,
  latest_data_json TEXT,
  latest_error TEXT,
  resolved_prep INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workflow, tracker_date, item_id)
);

CREATE INDEX IF NOT EXISTS idx_items_workflow_date ON items(workflow, tracker_date, latest_ts);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(workflow, tracker_date, latest_status);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  source_offset INTEGER NOT NULL,
  workflow TEXT NOT NULL,
  tracker_date TEXT NOT NULL,
  item_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  ts TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  UNIQUE(source_path, source_offset)
);

CREATE INDEX IF NOT EXISTS idx_logs_item_run ON logs(workflow, tracker_date, item_id, run_id, ts_ms);

CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  source_offset INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  workflow_instance TEXT,
  run_id TEXT,
  timestamp TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  tracker_date TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  UNIQUE(source_path, source_offset)
);

CREATE INDEX IF NOT EXISTS idx_session_events_run ON session_events(run_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_session_events_instance ON session_events(workflow_instance, ts_ms);
CREATE INDEX IF NOT EXISTS idx_session_events_date ON session_events(tracker_date, ts_ms);

CREATE TABLE IF NOT EXISTS files (
  file_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('pdf', 'screenshot', 'page-image', 'image', 'other')),
  mime_type TEXT NOT NULL,
  original_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  workflow TEXT,
  item_id TEXT,
  run_id TEXT,
  parent_run_id TEXT,
  source TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_owner ON files(workflow, item_id, run_id);
CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha256);
CREATE INDEX IF NOT EXISTS idx_files_run_id_screenshot
  ON files(run_id) WHERE kind = 'screenshot';

CREATE TABLE IF NOT EXISTS file_pages (
  file_id TEXT NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  render_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  image_path TEXT,
  mime_type TEXT,
  bytes INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (file_id, page, render_version)
);

CREATE INDEX IF NOT EXISTS idx_file_pages_status ON file_pages(status, updated_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  item_id TEXT NOT NULL,
  run_id TEXT,
  task_kind TEXT NOT NULL DEFAULT 'workflow_item',
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'queued',
      'running',
      'waiting_on_children',
      'awaiting_child_results',
      'done',
      'failed',
      'cancelled'
    )
  ),
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  control_state TEXT CHECK (
    control_state IN (
      'queued',
      'waiting_dependencies',
      'claimed',
      'running',
      'cancel_requested',
      'cancelling',
      'cancelled',
      'done',
      'failed',
      'blocked'
    )
  ),
  priority INTEGER NOT NULL DEFAULT 0,
  available_at TEXT,
  enqueued_at TEXT,
  current_attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
  parent_run_id TEXT,
  claimed_by_worker_id TEXT,
  claimed_at TEXT,
  claim_expires_at TEXT,
  cancel_requested_at TEXT,
  cancel_reason TEXT,
  terminal_error TEXT,
  source TEXT NOT NULL DEFAULT 'daemon',
  metadata_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS tasks_workflow_item_run_idx
  ON tasks(workflow, item_id, run_id)
  WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_status_idx
  ON tasks(status, updated_at);

CREATE INDEX IF NOT EXISTS tasks_parent_idx
  ON tasks(parent_task_id);

-- Cascade-cancel walks children by the parent RUN id
-- (cancelQueuedChildTasksForParentRun) and the tree-cancel resolver reads the
-- same column; without this partial index every discard/abort full-scans the
-- never-pruned tasks table (perf review of the E2E-010 cascade).
CREATE INDEX IF NOT EXISTS tasks_parent_run_idx
  ON tasks(parent_run_id) WHERE parent_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_control_claimable_idx
  ON tasks(workflow, control_state, priority DESC, enqueued_at ASC);

CREATE INDEX IF NOT EXISTS tasks_control_owner_idx
  ON tasks(claimed_by_worker_id, control_state);

CREATE INDEX IF NOT EXISTS tasks_tracker_identity_idx
  ON tasks(workflow, item_id);

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'done', 'failed', 'cancelled')
  ),
  tracker_workflow TEXT NOT NULL,
  tracker_item_id TEXT NOT NULL,
  started_at TEXT,
  terminal_at TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  control_state TEXT CHECK (
    control_state IN (
      'pending',
      'claimed',
      'running',
      'cancel_requested',
      'cancelled',
      'done',
      'failed'
    )
  ),
  worker_id TEXT,
  claimed_at TEXT,
  failed_at TEXT,
  error TEXT,
  UNIQUE(task_id, attempt_no),
  UNIQUE(tracker_workflow, tracker_item_id, run_id)
);

CREATE INDEX IF NOT EXISTS task_attempts_task_idx
  ON task_attempts(task_id, attempt_no DESC);

CREATE INDEX IF NOT EXISTS task_attempts_run_idx
  ON task_attempts(run_id);

CREATE INDEX IF NOT EXISTS task_attempts_worker_idx
  ON task_attempts(worker_id, control_state);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  child_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'satisfied', 'failed', 'cancelled')
  ),
  failure_policy TEXT NOT NULL CHECK (
    failure_policy IN ('record_unresolved', 'fail_parent', 'ignore')
  ),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  on_child_failed TEXT NOT NULL DEFAULT 'block_parent' CHECK (
    on_child_failed IN ('fail_parent', 'block_parent', 'allow_partial')
  ),
  cascade_cancel INTEGER NOT NULL DEFAULT 1,
  resume_parent_after_child_retry INTEGER NOT NULL DEFAULT 1,
  UNIQUE(parent_task_id, child_task_id, kind)
);

CREATE INDEX IF NOT EXISTS task_dependencies_parent_idx
  ON task_dependencies(parent_task_id, status);

CREATE INDEX IF NOT EXISTS task_dependencies_child_idx
  ON task_dependencies(child_task_id, status);

CREATE INDEX IF NOT EXISTS task_dependencies_pending_idx
  ON task_dependencies(status, updated_at);

CREATE TABLE IF NOT EXISTS workers (
  worker_id TEXT PRIMARY KEY,
  workflow TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('daemon', 'dashboard', 'pool', 'shared_context_pool')),
  pid INTEGER NOT NULL,
  parent_pid INTEGER,
  hostname TEXT NOT NULL,
  port INTEGER,
  instance_id TEXT,
  lockfile_path TEXT,
  phase TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting', 'alive', 'draining', 'stopped', 'dead', 'stale')),
  current_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  current_attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  last_heartbeat_at TEXT,
  heartbeat_ttl_ms INTEGER NOT NULL DEFAULT 30000,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS workers_workflow_status_idx
  ON workers(workflow, status, last_heartbeat_at);

CREATE INDEX IF NOT EXISTS workers_pid_idx
  ON workers(pid);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  heartbeat_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  phase TEXT NOT NULL,
  current_task_id TEXT,
  current_attempt_id TEXT,
  queue_depth INTEGER,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS worker_heartbeats_worker_ts_idx
  ON worker_heartbeats(worker_id, ts DESC);

CREATE TABLE IF NOT EXISTS browser_processes (
  browser_process_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
  workflow TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
  system_id TEXT NOT NULL,
  browser_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  session_dir TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'launched',
      'alive',
      'kill_requested',
      'terminated',
      'lost'
    )
  ),
  launched_at TEXT NOT NULL,
  last_seen_at TEXT,
  terminated_at TEXT,
  kill_command_id TEXT,
  metadata_json TEXT,
  UNIQUE(worker_id, system_id, pid)
);

CREATE INDEX IF NOT EXISTS browser_processes_pid_idx
  ON browser_processes(pid);

CREATE INDEX IF NOT EXISTS browser_processes_owner_idx
  ON browser_processes(worker_id, status);

CREATE INDEX IF NOT EXISTS browser_processes_attempt_idx
  ON browser_processes(attempt_id);

CREATE TABLE IF NOT EXISTS worker_commands (
  command_id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL CHECK (
    command_type IN (
      'cancel_task',
      'retry_task',
      'drain_worker',
      'stop_worker',
      'force_stop_task',
      'kill_browser',
      'force_kill_worker',
      'health_check'
    )
  ),
  state TEXT NOT NULL CHECK (
    state IN (
      'queued',
      'acknowledged',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  workflow TEXT,
  target_worker_id TEXT REFERENCES workers(worker_id) ON DELETE SET NULL,
  target_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  target_attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
  target_browser_process_id TEXT REFERENCES browser_processes(browser_process_id) ON DELETE SET NULL,
  requested_by TEXT NOT NULL DEFAULT 'dashboard',
  requested_at TEXT NOT NULL,
  acknowledged_at TEXT,
  completed_at TEXT,
  error TEXT,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS worker_commands_worker_state_idx
  ON worker_commands(target_worker_id, state, requested_at);

CREATE INDEX IF NOT EXISTS worker_commands_task_state_idx
  ON worker_commands(target_task_id, state, requested_at);
    `,
  },
  {
    // Migration 7: drop tasks.status and task_attempts.status legacy columns.
    //
    // These columns were the original state enum (v1/v2 schema). Migration v3
    // added control_state as the authoritative column and kept status as a
    // dual-write compat shim. With tracker data wiped on 2026-05-15 and all
    // dual-writes removed from application code, the columns are now dead.
    //
    // SQLite supports DROP COLUMN since 3.35.0 (Node 26's bundled sqlite is
    // new enough). The DROP rewrites the table — on a wiped DB this is
    // near-instant.
    //
    // OPERATOR NOTE: delete .tracker/state.db before first boot after this
    // change, or let the migration run automatically (it will be fast on a
    // small/empty DB). If the DB has millions of rows, the rewrite may take
    // tens of seconds — same as migration 6 for run_events.
    version: 7,
    sql: String.raw`
DROP INDEX IF EXISTS tasks_status_idx;
ALTER TABLE tasks DROP COLUMN status;
ALTER TABLE task_attempts DROP COLUMN status;
    `,
  },
  {
    version: 8,
    sql: String.raw`ALTER TABLE items ADD COLUMN latest_empl_id TEXT;`,
  },
  {
    // Migration 9: lifecycle-tied screenshot cleanup.
    // Stamps the timestamp at which a run reached its first terminal status
    // (done/failed/skipped/cancelled). NULL while still running. The sweep
    // joins (runs.terminal_at < now - 30d) with files (kind='screenshot') to
    // delete stale evidence — see src/tracker/state/screenshot-sweep.ts.
    version: 9,
    sql: String.raw`
ALTER TABLE runs ADD COLUMN terminal_at TEXT;
CREATE INDEX IF NOT EXISTS idx_runs_terminal_at ON runs(terminal_at);
    `,
  },
  {
    // Migration 10: OCR approved prep rows must stay in sidebar wfCounts.
    // `isResolvedPrepData` previously treated any `mode=prepare` approved row as
    // resolved, but OCR keeps approved prep visible until discarded — same rule as
    // `isResolvedPrepEntry` / the active-workflow queue count override.
    version: 10,
    sql: String.raw`
UPDATE items
SET resolved_prep = 0
WHERE workflow = 'ocr'
  AND resolved_prep = 1
  AND NOT (latest_status = 'failed' AND latest_step = 'discarded');
    `,
  },
  {
    // Migration 11: persist the pristine original input on every task.
    //
    // Contract 2 (Uniform Retry) — `retryTaskFromAttempt` re-runs the workflow
    // with the input the task was FIRST enqueued with. The new column captures
    // that snapshot at enqueue time; retry reads it directly.
    //
    // Three-way retry split in `reEnqueueEntry` (ops/retry.ts):
    //   - **SQLite-happy:** `original_input_json` is present → use it directly
    //     (`retryTaskFromAttempt` resets `input_json ← original_input_json`).
    //   - **SQLite-null-original:** row exists but `original_input_json` is
    //     null → structured error returned to the operator (this is a bug, not
    //     a legacy state, since migration 11 always stamps at enqueue).
    //   - **SQLite-pruned:** task record was deleted by `npm run clean:tracker`;
    //     JSONL audit is usually still present → JSONL + `enqueueFromHttp`
    //     rescue path (`findEntryInput` + `mergeAccumulatedTrackerStrings`).
    //
    // Nullable on purpose: rows enqueued before this migration ran hit the
    // null-original branch above, which returns a structured error.
    version: 11,
    sql: String.raw`
ALTER TABLE tasks ADD COLUMN original_input_json TEXT;
    `,
  },
  {
    // Migration 12: index tasks by parent_run_id. Cascade-cancel
    // (cancelQueuedChildTasksForParentRun) and the tree-cancel resolver walk
    // children by the parent RUN id; without the index every discard/abort
    // full-scans the never-pruned tasks table (perf review of the E2E-010
    // cascade). Partial — most tasks have no parent.
    version: 12,
    sql: String.raw`
CREATE INDEX IF NOT EXISTS tasks_parent_run_idx
  ON tasks(parent_run_id) WHERE parent_run_id IS NOT NULL;
    `,
  },
  {
    // Migration 13: claim lease generation (ISS-005).
    //
    // Stop-All / per-instance-stop teardown re-pends an in-flight item
    // (`returnTaskToQueued`) so a surviving peer can finish it — but the re-pend
    // kept the same attempt + runId, so a peer re-claimed the identical attempt
    // while the STOPPED instance was still finishing its run. When the stopped
    // instance then completed, its `markTaskDone` landed even though the peer now
    // owned the run: two workers each transacted the work (a duplicate oath
    // submission outside dry-run), though the task stayed idempotent.
    //
    // The lease is the guard: every claim bumps this counter, so the claiming
    // worker holds a generation. A terminal write supplied with a stale
    // generation (the original worker's, now behind the peer's re-claim) is a
    // no-op. NOT NULL DEFAULT 0 — existing rows start at generation 0, and the
    // next claim advances them, so no backfill is needed.
    version: 13,
    sql: String.raw`
ALTER TABLE tasks ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Migration 14: widen the worker_commands.command_type CHECK to admit the
    // per-browser session-panel controls `refresh_browser` (reload the page —
    // the refresh-only recovery) and `focus_browser` (bring the window to
    // front). SQLite can't ALTER a CHECK in place, so rebuild the table with
    // the expanded list. worker_commands is a LEAF (nothing references it), so
    // the drop/rename is safe even with foreign_keys ON; existing rows already
    // satisfy the (unchanged) FK references they carry. Indexes are recreated.
    version: 14,
    sql: String.raw`
CREATE TABLE worker_commands_v14 (
  command_id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL CHECK (
    command_type IN (
      'cancel_task',
      'retry_task',
      'drain_worker',
      'stop_worker',
      'force_stop_task',
      'kill_browser',
      'refresh_browser',
      'focus_browser',
      'force_kill_worker',
      'health_check'
    )
  ),
  state TEXT NOT NULL CHECK (
    state IN (
      'queued',
      'acknowledged',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  workflow TEXT,
  target_worker_id TEXT REFERENCES workers(worker_id) ON DELETE SET NULL,
  target_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  target_attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
  target_browser_process_id TEXT REFERENCES browser_processes(browser_process_id) ON DELETE SET NULL,
  requested_by TEXT NOT NULL DEFAULT 'dashboard',
  requested_at TEXT NOT NULL,
  acknowledged_at TEXT,
  completed_at TEXT,
  error TEXT,
  payload_json TEXT
);

INSERT INTO worker_commands_v14 SELECT * FROM worker_commands;
DROP TABLE worker_commands;
ALTER TABLE worker_commands_v14 RENAME TO worker_commands;

CREATE INDEX IF NOT EXISTS worker_commands_worker_state_idx
  ON worker_commands(target_worker_id, state, requested_at);

CREATE INDEX IF NOT EXISTS worker_commands_task_state_idx
  ON worker_commands(target_task_id, state, requested_at);
    `,
  },
];
