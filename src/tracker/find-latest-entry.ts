import { existsSync, readFileSync } from "node:fs";
import type { Database } from "../infra/sqlite/index.js";
import { log } from "../utils/log.js";
import { dateLocal, isTrackerEntry, isTrackerEntryStatus, type TrackerEntry } from "./jsonl-io.js";
import { rowFilePath } from "./paths.js";

export interface FindLatestEntryForPredicateOpts {
  workflow: string;
  predicate: (entry: TrackerEntry) => boolean;
  trackerDir?: string;
  lookbackDays?: number;
  now?: Date;
  /** SQLite DB handle. When supplied with runId or itemId, tries SQLite before JSONL. */
  db?: Database;
  /** Indexed lookup hint: find by run_id in the runs table. */
  runId?: string;
  /** Indexed lookup hint: find by item_id in the items table. */
  itemId?: string;
}

function parseDataJson(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
      else if (v !== null && v !== undefined) out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

function rowStatusOrUndefined(
  value: unknown,
  ctx: { source: string; workflow: string; itemId: string; runId?: string | null },
): TrackerEntry["status"] | undefined {
  if (isTrackerEntryStatus(value)) return value;
  log.warn(
    `[find-latest-entry] skipping SQLite ${ctx.source} row with invalid latest_status workflow=${ctx.workflow} item=${ctx.itemId}` +
      `${ctx.runId ? ` runId=${ctx.runId}` : ""} status=${String(value)}`,
  );
  return undefined;
}

function coerceJsonlTrackerEntry(value: unknown, workflow: string): TrackerEntry | null {
  if (isTrackerEntry(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const timestamp = typeof row.timestamp === "string"
    ? row.timestamp
    : typeof row.ts === "string" ? row.ts : undefined;
  if (
    typeof row.id !== "string" ||
    row.id.length === 0 ||
    !timestamp ||
    !isTrackerEntryStatus(row.status)
  ) {
    return null;
  }
  return {
    ...(row as Partial<TrackerEntry>),
    workflow: typeof row.workflow === "string" && row.workflow.length > 0 ? row.workflow : workflow,
    id: row.id,
    timestamp,
    status: row.status,
  };
}

/**
 * Search recent workflow JSONL files newest-first and return the first entry
 * accepted by `predicate`. Tolerates malformed lines the same way dashboard
 * fallback readers do.
 *
 * When `db` + `runId` or `db` + `itemId` are provided, queries SQLite first
 * (O(index) vs O(file-size)) before falling through to JSONL.
 */
export function findLatestEntryForPredicate(
  opts: FindLatestEntryForPredicateOpts,
): TrackerEntry | null {
  // SQLite fast path: try indexed lookup before scanning JSONL files.
  if (opts.db) {
    try {
      if (opts.runId) {
        const row = opts.db.prepare(`
          SELECT item_id, run_id, parent_run_id, latest_tracker_ts, latest_status, latest_step,
                 latest_data_json, latest_error
          FROM runs
          WHERE workflow = @workflow AND run_id = @runId
          ORDER BY latest_tracker_ts DESC LIMIT 1
        `).get({ workflow: opts.workflow, runId: opts.runId }) as {
          item_id: string;
          run_id: string;
          parent_run_id: string | null;
          latest_tracker_ts: string;
          latest_status: string;
          latest_step: string | null;
          latest_data_json: string | null;
          latest_error: string | null;
        } | undefined;
        if (row) {
          const status = rowStatusOrUndefined(row.latest_status, {
            source: "runs",
            workflow: opts.workflow,
            itemId: row.item_id,
            runId: row.run_id,
          });
          if (status) {
            const entry: TrackerEntry = {
              workflow: opts.workflow,
              id: row.item_id,
              runId: row.run_id,
              ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
              timestamp: row.latest_tracker_ts,
              status,
              ...(row.latest_step ? { step: row.latest_step } : {}),
              data: parseDataJson(row.latest_data_json),
              ...(row.latest_error ? { error: row.latest_error } : {}),
            };
            if (opts.predicate(entry)) return entry;
          }
        }
      } else if (opts.itemId) {
        // The `items` projection has no parent_run_id column; recover it from the
        // run's projection so itemId-only inheritance lookups keep member→parent
        // linkage (a missing parentRunId orphans batch/operation members on re-emit).
        const row = opts.db.prepare(`
          SELECT item_id, latest_run_id, latest_ts, latest_status, latest_step,
                 latest_data_json, latest_error,
                 (SELECT r.parent_run_id FROM runs r
                    WHERE r.workflow = items.workflow AND r.run_id = items.latest_run_id
                      AND r.parent_run_id IS NOT NULL
                    ORDER BY r.latest_tracker_ts DESC LIMIT 1) AS parent_run_id
          FROM items
          WHERE workflow = @workflow AND item_id = @itemId
          ORDER BY latest_ts DESC LIMIT 1
        `).get({ workflow: opts.workflow, itemId: opts.itemId }) as {
          item_id: string;
          latest_run_id: string;
          latest_ts: string;
          latest_status: string;
          latest_step: string | null;
          latest_data_json: string | null;
          latest_error: string | null;
          parent_run_id: string | null;
        } | undefined;
        if (row) {
          const status = rowStatusOrUndefined(row.latest_status, {
            source: "items",
            workflow: opts.workflow,
            itemId: row.item_id,
            runId: row.latest_run_id,
          });
          if (status) {
            const entry: TrackerEntry = {
              workflow: opts.workflow,
              id: row.item_id,
              runId: row.latest_run_id,
              ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
              timestamp: row.latest_ts,
              status,
              ...(row.latest_step ? { step: row.latest_step } : {}),
              data: parseDataJson(row.latest_data_json),
              ...(row.latest_error ? { error: row.latest_error } : {}),
            };
            if (opts.predicate(entry)) return entry;
          }
        }
      }
    } catch {
      // SQLite unavailable or schema mismatch — fall through to JSONL.
    }
  }

  const dir = opts.trackerDir ?? ".tracker";
  const lookbackDays = opts.lookbackDays ?? 7;
  const today = opts.now ?? new Date();
  for (let i = 0; i < lookbackDays; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const file = rowFilePath(opts.workflow, dateLocal(d), dir);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    for (let j = lines.length - 1; j >= 0; j--) {
      try {
        const parsed = JSON.parse(lines[j]) as unknown;
        const entry = coerceJsonlTrackerEntry(parsed, opts.workflow);
        if (!entry) {
          log.warn(`[find-latest-entry] skipping invalid tracker JSONL line ${j + 1} in ${file}`);
          continue;
        }
        if (opts.predicate(entry)) return entry;
      } catch (err) {
        log.warn(`[find-latest-entry] skipping malformed JSONL line ${j + 1} in ${file}: ${(err as Error).message}`);
      }
    }
  }
  return null;
}

/**
 * Read back the trace id frozen on a run's earliest row that carries one.
 * `data.__traceId` embeds the original pre-emit wall-clock timestamp, so any
 * later re-emit or rebuild for the same run MUST reuse this value rather than
 * minting a fresh one (which would drift the id by however many seconds elapsed
 * between emissions). Returns `undefined` when no prior row carries a trace id;
 * the caller then computes the canonical one itself.
 */
export function findFrozenTraceId(opts: {
  workflow: string;
  runId: string;
  trackerDir?: string;
  db?: Database;
}): string | undefined {
  const prior = findLatestEntryForPredicate({
    workflow: opts.workflow,
    ...(opts.trackerDir ? { trackerDir: opts.trackerDir } : {}),
    ...(opts.db ? { db: opts.db, runId: opts.runId } : {}),
    lookbackDays: 2,
    predicate: (entry) => entry.runId === opts.runId && Boolean(entry.data?.__traceId),
  });
  const id = prior?.data?.__traceId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
