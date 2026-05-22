import type { Database } from "../../../infra/sqlite/index.js";
import type { ProjectionHealth } from "../types.js";
import { stateDbPath } from "../db.js";
import { readStmts } from "./statements.js";

export function queryProjectionHealth(db: Database, dir: string): ProjectionHealth {
  const s = readStmts(db);
  const version = s.selectSchemaVersion.get() as { version: number } | undefined;
  const sourceCount = s.countProjectionSources.get() as { n: number };
  const runEventCount = s.countRunEvents.get() as { n: number };
  const logCount = s.countLogs.get() as { n: number };
  const sessionEventCount = s.countSessionEvents.get() as { n: number };
  return {
    ok: true,
    dbPath: stateDbPath(dir),
    schemaVersion: version?.version ?? 0,
    sourceCount: sourceCount.n,
    runEventCount: runEventCount.n,
    logCount: logCount.n,
    sessionEventCount: sessionEventCount.n,
  };
}
