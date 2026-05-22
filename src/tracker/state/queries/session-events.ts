import type { Database } from "../../../infra/sqlite/index.js";
import type { SessionEvent } from "../../session-events.js";
import { readStmts } from "./statements.js";

/**
 * Read every session event whose `run_id` matches `opts.runId` OR (for
 * batch-scope events emitted before the per-item ALS context was
 * established) whose `workflow_instance` matches `opts.workflowInstance`.
 * Time-window filtering happens client-side via `filterEventsForRun` so the
 * caller can pass the result straight through and get identical output to
 * the JSONL path.
 *
 * Returns events ordered by ts_ms ASC for deterministic SSE rendering.
 *
 * The session_events row stores the full event payload as `raw_json` (see
 * src/tracker/state/schema.ts:135). We deserialize that to recover the same
 * shape `readSessionEvents` returns from JSONL.
 */
export function querySessionEventsForRun(
  db: Database,
  opts: { runId: string; workflowInstance?: string },
): SessionEvent[] {
  const s = readStmts(db);
  const rows = opts.workflowInstance
    ? (s.selectSessionEventsByRunIdAndInstance.all({ runId: opts.runId, instance: opts.workflowInstance }) as Array<{ raw_json: string }>)
    : (s.selectSessionEventsByRunId.all({ runId: opts.runId }) as Array<{ raw_json: string }>);
  const out: SessionEvent[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.raw_json) as SessionEvent);
    } catch {
      // Skip — projection rebuild will reconcile.
    }
  }
  return out;
}
