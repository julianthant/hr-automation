import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  dateLocal,
  emitTrackerRow,
  emitTrackerRowForDate,
  listDatesForWorkflow,
  type StampedData,
  type TrackerEntry,
} from "../../tracker/jsonl.js";
import { serializeValue } from "../../tracker/jsonl-core.js";
import { readVisibleEntries, readVisibleEntriesForDate } from "../../tracker/deletions/visible.js";
import { resolveRowArchetype } from "../../domain/row-archetype.js";
import {
  daemonsDir,
} from "../../core/daemon/registry.js";
import { transaction } from "../../infra/sqlite/index.js";
import { openControlDb } from "../../core/control-db.js";
import { openControlStores, resolveControlTask } from "./shared.js";
import { isStateDbReady, openStateDb } from "../../tracker/state/db.js";
import { queryPriorEntriesByKey } from "../../tracker/state/queries.js";

export interface QueueBumpRequest {
  workflow: string;
  id: string;
  runId?: string;
}

export interface SaveDataRequest {
  workflow: string;
  id: string;
  date?: string;
  data: Record<string, unknown>;
}

/** Move a queued item to the head of the live queue via SQLite task priority. */
export function buildQueueBumpHandler(dir: string) {
  return async (
    req: QueueBumpRequest,
  ): Promise<{ ok: true } | { ok: false; error: string; status?: number }> => {
    if (!req.workflow || !req.id) return { ok: false, error: "workflow and id are required" };
    const stores = openControlStores(dir);
    const task = resolveControlTask(stores.taskStore, req.workflow, req.id, req.runId);
    if (task) {
      if (task.state !== "queued") {
        return {
          ok: false as const,
          error: `cannot bump item in state ${task.state}`,
          status: 409,
        };
      }
      const now = new Date().toISOString();
      const bumpFn = (): number => transaction(stores.taskStore.db, () => {
        const row = stores.taskStore.db.prepare(`
          SELECT COALESCE(MAX(priority), 0) + 1 AS priority
          FROM tasks
          WHERE workflow = @workflow AND control_state = 'queued'
        `).get({ workflow: req.workflow }) as { priority: number };
        const info = stores.taskStore.db.prepare(`
          UPDATE tasks
          SET priority = @priority,
              updated_at = @now
          WHERE id = @taskId AND control_state = 'queued'
        `).run({ taskId: task.taskId, priority: row.priority, now });
        return info.changes;
      });
      return bumpFn() === 1
        ? { ok: true as const }
        : { ok: false as const, error: "item already claimed by a daemon", status: 409 };
    }
    return {
      ok: false as const,
      error: "task not found in SQLite control store",
      status: 404,
    };
  };
}

/**
 * Save edited values onto an entry's tracker row WITHOUT triggering a new run.
 * Appends a synthetic tracker entry that mirrors the latest row's status,
 * step, and runId, but with `data` merged with the user's edits. The
 * frontend dedupe (latest-per-id) picks it up on next SSE tick so refreshes
 * preserve the saved values.
 *
 * Refuses to save when the latest status is `pending` or `running` — the
 * kernel may emit a status update concurrently and our synthetic row could
 * race / overwrite legitimate state. Terminal statuses (done / failed /
 * skipped) are safe to overlay.
 */
export function buildSaveDataHandler(dir: string) {
  return async (
    req: SaveDataRequest,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!req.workflow || !req.id || !req.data || typeof req.data !== "object") {
      return { ok: false, error: "workflow, id, and data are required" };
    }
    const entries = (req.date
      ? readVisibleEntriesForDate(req.workflow, req.date, dir)
      : readVisibleEntries(req.workflow, dir)).filter((e) => e.id === req.id);
    if (entries.length === 0) {
      return { ok: false, error: `no tracker entry found for id=${req.id}` };
    }
    entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    const latest = entries[0];
    if (latest.status === "pending" || latest.status === "running") {
      return {
        ok: false,
        error: `cannot save while entry is ${latest.status} — wait for it to finish`,
      };
    }
    // Coerce user-supplied values to strings (TrackerEntry.data is
    // Record<string, string>). EditDataTab posts every editable field, so an
    // empty string means the operator intentionally cleared the value.
    const merged: Record<string, string> = { ...(latest.data ?? {}) };
    for (const [k, v] of Object.entries(req.data)) {
      merged[k] = serializeValue(v, k);
    }
    // Inherit archetype from the prior row — save-data is a no-status-change
    // overlay so the row type must not change.
    const priorArchetype = resolveRowArchetype(latest);
    const mergedStamped: StampedData = { ...merged, archetype: priorArchetype };
    const emission = {
      workflow: req.workflow,
      timestamp: new Date().toISOString(),
      id: req.id,
      ...(latest.runId ? { runId: latest.runId } : {}),
      ...(latest.parentRunId ? { parentRunId: latest.parentRunId } : {}),
      status: latest.status,
      ...(latest.step ? { step: latest.step } : {}),
      data: mergedStamped,
      // Don't carry `input` — that field is reserved for `pending` rows by
      // the kernel; this synthetic row never originated from an enqueue.
      ...(latest.error ? { error: latest.error } : {}),
    };
    if (req.date) {
      emitTrackerRowForDate(emission, req.date, dir);
    } else {
      emitTrackerRow(emission, dir);
    }
    return { ok: true };
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Find prior runs by data-field key (EditDataTab "Copy from prior" lookup)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Shape returned to the dashboard from `/api/find-prior-by-key`. Only the
 * fields the EditDataTab needs to render the prior-runs list and copy
 * data — full TrackerEntry includes runtime-internal noise we don't want
 * to ship over the wire.
 */
export interface PriorEntrySummary {
  id: string;
  runId?: string;
  status: string;
  step?: string;
  timestamp: string;
  date: string;
  data: Record<string, string>;
}

export interface FindPriorByKeyRequest {
  workflow: string;
  keyField: string;
  keyValue: string;
  /** Caller's current entry id — excluded from the result so the form
   *  doesn't suggest copying from itself. */
  excludeId?: string;
  /** Lookback window in days. Defaults to 90 to cover the typical fiscal
   *  quarter; capped at 365 to bound the file scan. */
  days?: number;
}

/**
 * Find prior tracker entries for `workflow` whose `data[keyField]` equals
 * `keyValue` and whose `id` differs from `excludeId`. Scans up to `days`
 * days back, dedupes by `id` (keeps the latest entry per id), and returns
 * `PriorEntrySummary[]` sorted newest first.
 *
 * Designed for the dashboard's "Copy from prior run" affordance in
 * `EditDataTab` — the workflow declares a `matchKey` (e.g. `"eid"` for
 * separations) and the EditDataTab calls this endpoint to surface other
 * runs that share the same matching identifier so the operator can pull
 * their data forward into the current edit form.
 *
 * Filters:
 *   - Skips entries whose `data[keyField]` is empty or unset.
 *   - Skips entries whose `id` matches `excludeId` (case-sensitive — the
 *     dashboard always passes the canonical id).
 *   - Skips terminal-cancelled entries (`status: "failed", step: "cancelled"`)
 *     and discarded prep rows (`step: "discarded"`) — those carry no
 *     useful extracted data.
 */
export function findPriorEntriesByKey(
  workflow: string,
  keyField: string,
  keyValue: string,
  excludeId: string | undefined,
  dir: string,
  opts: { days?: number } = {},
): PriorEntrySummary[] {
  const days = Math.max(1, Math.min(opts.days ?? 90, 365));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffMs = cutoff.getTime();
  const wantedValue = keyValue.trim();
  if (!wantedValue) return [];

  // SQLite fast path: query the `items` table (latest event per item_id per date)
  // when the projection DB is available. Falls back to JSONL scan on any hiccup.
  if (isStateDbReady(dir)) {
    try {
      const db = openStateDb(dir);
      // Match the JSONL fallback's local-time cutoff. UTC slicing here would
      // shift the cutoff by a day for late-evening queries in negative-UTC
      // timezones (US/PT), silently dropping the boundary day's hits.
      const cutoffDate = dateLocal(cutoff);
      const rows = queryPriorEntriesByKey(db, {
        workflow,
        keyField,
        keyValue: wantedValue,
        excludeId,
        cutoffDate,
      });
      return rows.map((row) => ({
        id: row.id,
        runId: row.runId ?? undefined,
        status: row.status,
        step: row.step ?? undefined,
        timestamp: row.timestamp,
        date: row.date,
        data: row.data as Record<string, string>,
      }));
    } catch {
      // Fall through to JSONL on any SQLite error.
    }
  }

  const allDates = listDatesForWorkflow(workflow, dir);
  // listDatesForWorkflow returns YYYY-MM-DD strings sorted desc; only walk
  // the last `days` worth so we don't scan years of history when the
  // operator only cares about the recent quarter.
  const recentDates = allDates.filter((d) => {
    const t = new Date(d + "T00:00:00").getTime();
    return Number.isFinite(t) && t >= cutoffMs;
  });

  // id → latest entry seen (across all dates).
  const latestById = new Map<string, { entry: TrackerEntry; date: string }>();

  for (const date of recentDates) {
    const entries = readVisibleEntriesForDate(workflow, date, dir);
    for (const e of entries) {
      const value = e.data?.[keyField];
      if (!value || String(value).trim() !== wantedValue) continue;
      if (excludeId && e.id === excludeId) continue;
      // Filter out terminal-cancelled / discarded synthetics — they carry
      // no extracted data worth copying.
      if (e.status === "failed" && (e.step === "cancelled" || e.step === "discarded")) continue;
      const prev = latestById.get(e.id);
      if (!prev || prev.entry.timestamp < e.timestamp) {
        latestById.set(e.id, { entry: e, date });
      }
    }
  }

  return [...latestById.values()]
    .sort((a, b) => (a.entry.timestamp < b.entry.timestamp ? 1 : -1))
    .map(({ entry, date }) => ({
      id: entry.id,
      runId: entry.runId,
      status: entry.status,
      step: entry.step,
      timestamp: entry.timestamp,
      date,
      data: { ...(entry.data ?? {}) },
    }));
}

export function buildFindPriorByKeyHandler(dir: string) {
  return (
    req: FindPriorByKeyRequest,
  ): { ok: true; entries: PriorEntrySummary[] } | { ok: false; error: string } => {
    if (!req.workflow || !req.keyField || !req.keyValue) {
      return { ok: false, error: "workflow, keyField, and keyValue are required" };
    }
    const entries = findPriorEntriesByKey(
      req.workflow,
      req.keyField,
      req.keyValue,
      req.excludeId,
      dir,
      { days: req.days },
    );
    return { ok: true, entries };
  };
}

/** Resolve a daemon log file path from PID, validated against the daemon registry. */
export async function resolveDaemonLogPath(
  pid: number,
  dir: string,
): Promise<string | null> {
  const d = daemonsDir(dir);
  if (!existsSync(d)) return null;
  for (const file of readdirSync(d)) {
    if (!file.endsWith(".lock.json")) continue;
    let lock: { pid?: number; workflow?: string };
    try {
      lock = JSON.parse(readFileSync(join(d, file), "utf8")) as typeof lock;
    } catch {
      continue;
    }
    if (lock.pid === pid && lock.workflow) {
      const logPath = join(d, `${lock.workflow}-${pid}.log`);
      return existsSync(logPath) ? logPath : null;
    }
  }
  return null;
}

/** Per-workflow queue depth — count of daemon `workflow_item` tasks in `state === "queued"`. */
export function readQueueDepth(workflow: string, dir: string): number {
  const { db } = openControlDb({ trackerDir: dir });
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE workflow = ?
      AND control_state = 'queued'
      AND task_kind = 'workflow_item'
      AND source = 'daemon'
  `).get(workflow) as { n: number };
  return row?.n ?? 0;
}
