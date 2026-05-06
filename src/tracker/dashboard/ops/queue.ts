import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { mkdir, rmdir } from "fs/promises";
import { setTimeout as delay } from "timers/promises";
import { join } from "path";
import {
  listDatesForWorkflow,
  readEntries,
  readEntriesForDate,
  trackEvent,
  type TrackerEntry,
} from "../../jsonl.js";
import {
  daemonsDir,
} from "../../../core/daemon-registry.js";
import { openControlDb } from "../../../core/control-db.js";
import { createTaskStore } from "../../../core/task-store/index.js";
import { queueFilePath, queueLockDirPath } from "../../../core/daemon-queue.js";
import type { QueueEvent } from "../../../core/daemon-types.js";
import { openControlStores, resolveControlTask } from "./shared.js";

export interface QueueBumpRequest {
  workflow: string;
  id: string;
  runId?: string;
}

export interface SaveDataRequest {
  workflow: string;
  id: string;
  data: Record<string, unknown>;
}

/** Legacy JSONL fallback lock. SQLite-backed queue mutations use DB transactions. */
async function withQueueLock<T>(
  workflow: string,
  dir: string,
  body: () => Promise<T>,
): Promise<T> {
  const lockDir = queueLockDirPath(workflow, dir);
  const start = Date.now();
  // Match the timing characteristics of claimNextItem (10 attempts × 100ms = 1s).
  for (let i = 0; i < 30; i++) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        return await body();
      } finally {
        await rmdir(lockDir).catch(() => {});
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        if (Date.now() - start > 5_000) {
          throw new Error("queue lock acquisition timed out");
        }
        await delay(100);
        continue;
      }
      throw err;
    }
  }
  throw new Error("queue lock acquisition exhausted");
}

/**
 * Move a queued item to the head of the live queue. SQLite-backed tasks use
 * priority ordering; the JSONL rewrite below remains only for migration
 * fallback rows that do not have a task record.
 */
export function buildQueueBumpHandler(dir: string) {
  return async (
    req: QueueBumpRequest,
  ): Promise<{ ok: true } | { ok: false; error: string; status?: number }> => {
    if (!req.workflow || !req.id) return { ok: false, error: "workflow and id are required" };
    const stores = openControlStores(dir);
    try {
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
        const bump = stores.taskStore.db.transaction(() => {
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
        return bump() === 1
          ? { ok: true as const }
          : { ok: false as const, error: "item already claimed by a daemon", status: 409 };
      }
    } finally {
      stores.close();
    }
    return withQueueLock(req.workflow, dir, async () => {
      const path = queueFilePath(req.workflow, dir);
      if (!existsSync(path)) return { ok: false as const, error: "queue file does not exist" };
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n").filter((l) => l.trim());

      // Walk the events to find the target's enqueue event and confirm
      // the item is still queued (no claim / done / failed afterwards).
      let targetEnqueue: string | null = null;
      let state: "queued" | "claimed" | "done" | "failed" | "missing" = "missing";
      const otherLines: string[] = [];
      for (const line of lines) {
        let ev: QueueEvent;
        try {
          ev = JSON.parse(line) as QueueEvent;
        } catch {
          // Preserve unparseable lines verbatim.
          otherLines.push(line);
          continue;
        }
        if ((ev as { id?: string }).id !== req.id) {
          otherLines.push(line);
          continue;
        }
        if (ev.type === "enqueue") {
          if (targetEnqueue !== null) {
            // Duplicate enqueues for the same id are a queue-file
            // corruption; preserve verbatim and abort the bump.
            otherLines.push(line);
          } else {
            targetEnqueue = line;
            state = "queued";
          }
        } else if (ev.type === "claim") {
          state = "claimed";
          otherLines.push(line);
        } else if (ev.type === "unclaim") {
          state = "queued";
          otherLines.push(line);
        } else if (ev.type === "done") {
          state = "done";
          otherLines.push(line);
        } else if (ev.type === "failed") {
          state = "failed";
          otherLines.push(line);
        } else {
          otherLines.push(line);
        }
      }
      if (state === "missing" || targetEnqueue === null) {
        return { ok: false as const, error: "id not found in queue", status: 404 };
      }
      if (state !== "queued") {
        return {
          ok: false as const,
          error: `cannot bump item in state ${state}`,
          status: 409,
        };
      }
      // Rewrite: target enqueue first, then everything else in original order.
      const newText = [targetEnqueue, ...otherLines].join("\n") + "\n";
      writeFileSync(path, newText);
      return { ok: true as const };
    });
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
    const entries = readEntries(req.workflow, dir).filter((e) => e.id === req.id);
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
    // Record<string, string>). Drop empty strings only when they would
    // overwrite a non-empty existing value, so deliberately-cleared fields
    // round-trip but blanks from un-touched inputs don't clobber prior data.
    const merged: Record<string, string> = { ...(latest.data ?? {}) };
    for (const [k, v] of Object.entries(req.data)) {
      const next = typeof v === "string" ? v : v == null ? "" : String(v);
      if (next === "" && merged[k]) continue;
      merged[k] = next;
    }
    const entry: TrackerEntry = {
      workflow: req.workflow,
      timestamp: new Date().toISOString(),
      id: req.id,
      runId: latest.runId,
      status: latest.status,
      step: latest.step,
      data: merged,
      // Don't carry `input` — that field is reserved for `pending` rows by
      // the kernel; this synthetic row never originated from an enqueue.
      error: latest.error,
    };
    trackEvent(entry, dir);
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
    const entries = readEntriesForDate(workflow, date, dir);
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

/** Per-workflow queue depth — count of `state === "queued"` items. */
export function readQueueDepth(workflow: string, dir: string): number {
  try {
    const store = createTaskStore(openControlDb({ trackerDir: dir }));
    const tasks = store.listTasksForWorkflow(workflow);
    if (tasks.length > 0) return tasks.filter((task) => task.state === "queued").length;
  } catch {
    /* fall through to legacy queue-file depth */
  }
  const path = queueFilePath(workflow, dir);
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  // Quick fold — count enqueues minus claims/dones/faileds for those ids.
  const states = new Map<string, "queued" | "claimed" | "done" | "failed">();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: QueueEvent;
    try {
      ev = JSON.parse(line) as QueueEvent;
    } catch {
      continue;
    }
    const id = (ev as { id?: string }).id;
    if (!id) continue;
    if (ev.type === "enqueue") states.set(id, "queued");
    else if (ev.type === "claim") states.set(id, "claimed");
    else if (ev.type === "unclaim") states.set(id, "queued");
    else if (ev.type === "done") states.set(id, "done");
    else if (ev.type === "failed") states.set(id, "failed");
  }
  let count = 0;
  for (const s of states.values()) if (s === "queued") count++;
  return count;
}
