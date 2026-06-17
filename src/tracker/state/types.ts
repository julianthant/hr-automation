export type ProjectionSourceKind = "tracker" | "log" | "session";

export interface ProjectionSourceRef {
  sourceKind: ProjectionSourceKind;
  workflow?: string;
  trackerDate?: string;
  path: string;
  line?: number;
  offset: number;
}

export interface ProjectionHealth {
  ok: boolean;
  dbPath: string;
  schemaVersion: number;
  sourceCount: number;
  runEventCount: number;
  logCount: number;
  sessionEventCount: number;
}

export interface ProjectionEntriesPayload {
  entries: unknown[];
  workflows: string[];
  wfCounts: Record<string, number>;
  /** Collapsed top-level QUEUED surface count per workflow (rail "queued" sub-badge; always <= wfCounts). */
  wfQueuedCounts: Record<string, number>;
  failureCounts: Record<string, number>;
  source: "sqlite";
}

export interface LogEntryRow {
  id: number;
  source_path: string;
  source_line: number;
  source_offset: number;
  workflow: string;
  tracker_date: string;
  item_id: string;
  run_id: string;
  level: string;
  message: string;
  ts: string;
  ts_ms: number;
  raw_json: string;
  applied_at: string;
}

export interface RunEventRow {
  id: number;
  source_path: string;
  source_line: number;
  source_offset: number;
  workflow: string;
  tracker_date: string;
  item_id: string;
  run_id: string;
  parent_run_id: string | null;
  status: string;
  step: string | null;
  event_ts: string;
  event_ms: number;
  data_json: string | null;
  typed_data_json: string | null;
  input_json: string | null;
  error: string | null;
  applied_at: string;
}
