import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../infra/sqlite/index.js";
import { dateLocal, type TrackerEntry } from "./jsonl.js";

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
          SELECT item_id, run_id, latest_tracker_ts, latest_status, latest_step,
                 latest_data_json, latest_error
          FROM runs
          WHERE workflow = @workflow AND run_id = @runId
          ORDER BY latest_tracker_ts DESC LIMIT 1
        `).get({ workflow: opts.workflow, runId: opts.runId }) as {
          item_id: string;
          run_id: string;
          latest_tracker_ts: string;
          latest_status: string;
          latest_step: string | null;
          latest_data_json: string | null;
          latest_error: string | null;
        } | undefined;
        if (row) {
          const entry: TrackerEntry = {
            workflow: opts.workflow,
            id: row.item_id,
            runId: row.run_id,
            timestamp: row.latest_tracker_ts,
            status: row.latest_status as TrackerEntry["status"],
            ...(row.latest_step ? { step: row.latest_step } : {}),
            data: parseDataJson(row.latest_data_json),
            ...(row.latest_error ? { error: row.latest_error } : {}),
          };
          if (opts.predicate(entry)) return entry;
        }
      } else if (opts.itemId) {
        const row = opts.db.prepare(`
          SELECT item_id, latest_run_id, latest_ts, latest_status, latest_step,
                 latest_data_json, latest_error
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
        } | undefined;
        if (row) {
          const entry: TrackerEntry = {
            workflow: opts.workflow,
            id: row.item_id,
            runId: row.latest_run_id,
            timestamp: row.latest_ts,
            status: row.latest_status as TrackerEntry["status"],
            ...(row.latest_step ? { step: row.latest_step } : {}),
            data: parseDataJson(row.latest_data_json),
            ...(row.latest_error ? { error: row.latest_error } : {}),
          };
          if (opts.predicate(entry)) return entry;
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
    const file = join(dir, `${opts.workflow}-${dateLocal(d)}.jsonl`);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    for (let j = lines.length - 1; j >= 0; j--) {
      try {
        const entry = JSON.parse(lines[j]) as TrackerEntry;
        if (opts.predicate(entry)) return entry;
      } catch {
        /* tolerate malformed JSONL */
      }
    }
  }
  return null;
}
