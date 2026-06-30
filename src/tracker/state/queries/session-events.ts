import type { Database, Statement } from "../../../infra/sqlite/index.js";
import type { SessionEvent } from "../../session-events.js";
import { readStmts } from "./statements.js";

/**
 * Cache of the operation-coordinator IN-branch prepared statement, keyed by
 * `(instanceClause, placeholders)` shape per Database handle.
 *
 * The run-events SSE topic polls every 500ms; the coordinator branch builds an
 * ad-hoc statement whose `IN (...)` list is variadic, so it cannot reuse the
 * shared cached `readStmts` hot-path statements. Without this cache the SQL
 * bytecode is recompiled every tick — `db.prepare()` blocks the Node event
 * loop, stalling other SSE topics on that tick. The `placeholders` string
 * (`@m0, @m1, ...`) encodes the member COUNT, so the cache key is stable once
 * fan-out membership settles (only the bound member-id VALUES change per tick,
 * which needs no recompile). A `WeakMap` on the Database handle self-invalidates
 * when the DB handle is replaced (e.g. `.tracker/state.db` recreated).
 */
const coordinatorStmtCache = new WeakMap<Database, Map<string, Statement>>();

function getCoordinatorStmt(
  db: Database,
  instanceClause: string,
  placeholders: string,
): Statement {
  let byShape = coordinatorStmtCache.get(db);
  if (!byShape) {
    byShape = new Map();
    coordinatorStmtCache.set(db, byShape);
  }
  const key = `${instanceClause}\0${placeholders}`;
  let stmt = byShape.get(key);
  if (!stmt) {
    stmt = db.prepare(
      `SELECT raw_json FROM session_events
       WHERE run_id = @runId ${instanceClause} OR run_id IN (${placeholders})
       ORDER BY ts_ms ASC, id ASC`,
    );
    byShape.set(key, stmt);
  }
  return stmt;
}

/**
 * Read every session event whose `run_id` matches `opts.runId` OR (for
 * batch-scope events emitted before the per-item ALS context was
 * established, i.e. `run_id IS NULL`) whose `workflow_instance` matches
 * `opts.workflowInstance` — plus, when `opts.memberRunIds` is given, events
 * carrying one of those member run ids. Time-window + relevance filtering
 * happens client-side via `filterEventsForRun` so the caller can pass the
 * result straight through and get identical output to the JSONL path.
 *
 * `memberRunIds` is the operation-coordinator case: the coordinator is the
 * consolidated event tracker for its fanned-out members, so its members'
 * `item_start` markers (which carry the MEMBER's run_id, not the coordinator's,
 * and so would be dropped by the runId/instance clauses) must be pulled in too.
 * `filterEventsForRun` then keeps only the relevant member markers. Empty/absent
 * `memberRunIds` keeps the cached prepared-statement hot path (normal runs)
 * untouched — it never widens a non-coordinator query to the whole instance.
 *
 * Returns events ordered by ts_ms ASC for deterministic SSE rendering.
 *
 * The session_events row stores the full event payload as `raw_json` (see
 * src/tracker/state/schema.ts:135). We deserialize that to recover the same
 * shape `readSessionEvents` returns from JSONL.
 */
export function querySessionEventsForRun(
  db: Database,
  opts: { runId: string; workflowInstance?: string; memberRunIds?: readonly string[] },
): SessionEvent[] {
  const s = readStmts(db);
  const members = (opts.memberRunIds ?? []).filter((r) => r && r !== opts.runId);
  let rows: Array<{ raw_json: string }>;
  if (members.length > 0) {
    // Operation coordinator: union the runId / batch-scope clauses with the
    // member run ids. The IN list is variadic, so this can't use the shared
    // `readStmts` cache — instead the per-shape statement is cached by
    // `(instanceClause, placeholders)` (see `getCoordinatorStmt`) so the 500ms
    // SSE tick reuses it instead of recompiling SQL every poll. Only reached on
    // the coordinator path, never the normal hot path.
    const placeholders = members.map((_, i) => `@m${i}`).join(", ");
    const instanceClause = opts.workflowInstance
      ? "OR (run_id IS NULL AND workflow_instance = @instance)"
      : "";
    const stmt = getCoordinatorStmt(db, instanceClause, placeholders);
    const bindings: Record<string, string> = { runId: opts.runId };
    if (opts.workflowInstance) bindings.instance = opts.workflowInstance;
    members.forEach((r, i) => { bindings[`m${i}`] = r; });
    rows = stmt.all(bindings) as Array<{ raw_json: string }>;
  } else if (opts.workflowInstance) {
    rows = s.selectSessionEventsByRunIdAndInstance.all({ runId: opts.runId, instance: opts.workflowInstance }) as Array<{ raw_json: string }>;
  } else {
    rows = s.selectSessionEventsByRunId.all({ runId: opts.runId }) as Array<{ raw_json: string }>;
  }
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
