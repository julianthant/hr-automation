export interface Migration {
  version: number;
  sql: string;
}

export const LATEST_SCHEMA_VERSION = 1;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
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
  raw_json TEXT NOT NULL,
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
  raw_json TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  UNIQUE(source_path, source_offset)
);

CREATE INDEX IF NOT EXISTS idx_session_events_run ON session_events(run_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_session_events_instance ON session_events(workflow_instance, ts_ms);

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
    `,
  },
];
