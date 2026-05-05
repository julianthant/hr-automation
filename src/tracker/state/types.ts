export type ProjectionSourceKind = "tracker" | "log" | "session";

export interface ProjectionSourceRef {
  sourceKind: ProjectionSourceKind;
  workflow?: string;
  trackerDate?: string;
  path: string;
  line: number;
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
  failureCounts: Record<string, number>;
  source: "sqlite";
}
