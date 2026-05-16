/**
 * Watch a workflow's JSONL until N expected itemIds reach terminal status.
 *
 * Hoisted from the duplicated watchers in src/workflows/oath-signature/prepare.ts
 * and src/workflows/emergency-contact/prepare.ts (both deleted as part of the
 * OCR migration).
 *
 * Filters by explicit `expectedItemIds` (deterministic at spawn time), NOT by
 * `parentRunId` — parentRunId is purely for dashboard visualization.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  watch as fsWatch,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { TrackerEntry } from "../jsonl.js";
import { createOperatorDiscardError } from "../ocr-prepare-abort.js";
import { openControlDb } from "../../core/control-db.js";
import { createTaskStore, type TaskRow } from "../../core/task-store/index.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";

export interface ChildOutcome {
  workflow: string;
  itemId: string;
  runId: string;
  status: "done" | "failed";
  data?: Record<string, string>;
  error?: string;
}

export interface WatchChildRunsOpts {
  /** Workflow name whose JSONL we watch. */
  workflow: string;
  /** Specific itemIds to wait for. Resolves when all reach terminal status. */
  expectedItemIds: string[];
  /** Tracker dir. Default: `.tracker`. */
  trackerDir?: string;
  /** YYYY-MM-DD; default today (local). */
  date?: string;
  /** Hard timeout in ms. Default 1h. Rejects with `Error("watchChildRuns timeout")`. */
  timeoutMs?: number;
  /** Custom terminal predicate. Default: status in {done, failed}. */
  isTerminal?: (entry: TrackerEntry) => boolean;
  /** Fired as each expected item terminates, with the remaining count. */
  onProgress?: (outcome: ChildOutcome, remaining: number) => void;
  /**
   * If set, the watcher polls the latest entry on `(workflow, id)` and
   * aborts the watch when that entry's `step` matches. Used for
   * dashboard-driven soft-cancel: an HTTP cancel handler writes a
   * sentinel running entry on the parent's own row, and the watcher
   * (running in the daemon process) sees it and rejects so the handler
   * can unwind.
   */
  abortIfRowState?: {
    workflow: string;
    id: string;
    step: string;
  };
  /**
   * Dashboard-process OCR prepare: rejects when `/api/ocr/discard-prepare`
   * set the abort flag for this session (same-event-loop as the watcher).
   */
  shouldAbort?: () => boolean;
  /** @internal test seam for fs.watch failure/backoff coverage. */
  watcherFactory?: typeof fsWatch;
}

const DEFAULT_TIMEOUT_MS = 60 * 60_000;
/** JSONL fallback and SQLite poll cadence — keep both paths aligned. */
const WATCH_CHILD_POLL_MS = 200;

interface AbortFileCache {
  path: string;
  size: number;
  mtimeMs: number;
  result: boolean;
  readOffset: number;
  utf8Pending: string;
  lastStepForId: string | undefined;
}

function readAbortRequestedCached(
  opts: WatchChildRunsOpts,
  dir: string,
  date: string,
  cache: { current: AbortFileCache | null },
): boolean {
  if (!opts.abortIfRowState) return false;
  const sentinel = opts.abortIfRowState;
  const abortFile = join(dir, `${sentinel.workflow}-${date}.jsonl`);
  if (!existsSync(abortFile)) {
    cache.current = null;
    return false;
  }
  let st;
  try {
    st = statSync(abortFile);
  } catch {
    return false;
  }
  const prev = cache.current;
  if (
    prev &&
    prev.path === abortFile &&
    prev.size === st.size &&
    prev.mtimeMs === st.mtimeMs
  ) {
    return prev.result;
  }

  let readOffset = 0;
  let utf8Pending = "";
  let lastStepForId: string | undefined;
  const sameFile = prev?.path === abortFile;
  if (sameFile && prev && st.size >= prev.readOffset) {
    readOffset = prev.readOffset;
    utf8Pending = prev.utf8Pending;
    lastStepForId = prev.lastStepForId;
  }
  if (sameFile && prev && st.size < prev.readOffset) {
    readOffset = 0;
    utf8Pending = "";
    lastStepForId = undefined;
  }

  if (st.size > readOffset) {
    try {
      const fd = openSync(abortFile, "r");
      try {
        const byteLen = st.size - readOffset;
        const buf = Buffer.alloc(byteLen);
        let total = 0;
        while (total < byteLen) {
          const n = readSync(fd, buf, total, byteLen - total, readOffset + total);
          if (n === 0) break;
          total += n;
        }
        const chunk = buf.subarray(0, total).toString("utf8");
        const combined = utf8Pending + chunk;
        const lines = combined.split("\n");
        utf8Pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          let entry: TrackerEntry;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          if (entry.id !== sentinel.id) continue;
          lastStepForId = entry.step;
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  readOffset = st.size;
  const result = lastStepForId === sentinel.step;
  cache.current = {
    path: abortFile,
    size: st.size,
    mtimeMs: st.mtimeMs,
    result,
    readOffset,
    utf8Pending,
    lastStepForId,
  };
  return result;
}

function dateLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function maybeWatchSqliteChildRuns(
  opts: WatchChildRunsOpts,
  dir: string,
): Promise<ChildOutcome[] | null> {
  let controlDb: ReturnType<typeof openControlDb> | null = null;
  let taskStore: ReturnType<typeof createTaskStore>;
  let tasks: TaskRow[];
  try {
    controlDb = openControlDb({ trackerDir: dir });
    taskStore = createTaskStore(controlDb);
    const byItem = new Map(
      taskStore
        .listTasksForWorkflow(opts.workflow)
        .filter((task) => opts.expectedItemIds.includes(task.itemId))
        .map((task) => [task.itemId, task]),
    );
    if (byItem.size !== opts.expectedItemIds.length) {
      controlDb.close();
      return null;
    }
    tasks = opts.expectedItemIds.map((itemId) => byItem.get(itemId)!).filter(Boolean);
  } catch {
    controlDb?.close();
    return null;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = WATCH_CHILD_POLL_MS;
  const started = Date.now();
  const outcomes: ChildOutcome[] = [];
  const seen = new Set<string>();
  const abortCache: { current: AbortFileCache | null } = { current: null };
  const dateForAbort = opts.date ?? dateLocal();

  try {
    for (;;) {
      rejectIfDiscardRequested(opts);
      if (readAbortRequestedCached(opts, dir, dateForAbort, abortCache)) {
        throw new Error(
          `watchChildRuns aborted by parent row state (${opts.abortIfRowState!.workflow}/${opts.abortIfRowState!.id} step="${opts.abortIfRowState!.step}")`,
        );
      }
      for (const task of tasks) {
        if (seen.has(task.itemId)) continue;
        const fresh = taskStore.getTask(task.taskId);
        if (!fresh) continue;
        const status = sqliteTaskStatus(fresh);
        if (!status) continue;
        const projected = readLatestRunFromProjection(taskStore, {
          workflow: fresh.workflow,
          itemId: fresh.itemId,
          runId: fresh.currentRunId ?? fresh.runId ?? undefined,
        });
        const synthetic: TrackerEntry = {
          workflow: fresh.workflow,
          id: fresh.itemId,
          runId: fresh.currentRunId ?? fresh.runId,
          timestamp: new Date().toISOString(),
          status,
          data: projected?.data ?? {},
          error: projected?.error ?? fresh.error,
        };
        const isTerminal = opts.isTerminal ?? ((e: TrackerEntry) => e.status === "done" || e.status === "failed");
        if (!isTerminal(synthetic)) continue;
        const outcome: ChildOutcome = {
          workflow: fresh.workflow,
          itemId: fresh.itemId,
          runId: fresh.currentRunId ?? fresh.runId ?? "",
          status,
          data: synthetic.data,
          error: synthetic.error,
        };
        outcomes.push(outcome);
        seen.add(fresh.itemId);
        opts.onProgress?.(outcome, tasks.length - outcomes.length);
      }
      if (seen.size === tasks.length) return outcomes;
      const blockedParent = findBlockedParent(taskStore, tasks);
      if (blockedParent) {
        throw new Error(`watchChildRuns blocked by parent task ${blockedParent.taskId}`);
      }
      if (Date.now() - started > timeoutMs) {
        const waiting = tasks.filter((task) => !seen.has(task.itemId)).map((task) => task.itemId).join(", ");
        throw new Error(`watchChildRuns timeout (${timeoutMs}ms) — still waiting for: ${waiting}`);
      }
      await sleep(pollMs);
    }
  } finally {
    controlDb.close();
  }
}

function readLatestRunFromProjection(
  taskStore: ReturnType<typeof createTaskStore>,
  args: { workflow: string; itemId: string; runId?: string },
): { data: Record<string, string>; error?: string } | null {
  const row = taskStore.db.prepare(`
    SELECT latest_data_json, latest_error
    FROM runs
    WHERE workflow = @workflow
      AND item_id = @itemId
      AND (@runId IS NULL OR run_id = @runId)
    ORDER BY latest_tracker_ts DESC
    LIMIT 1
  `).get({
    workflow: args.workflow,
    itemId: args.itemId,
    runId: args.runId ?? null,
  }) as { latest_data_json: string | null; latest_error: string | null } | undefined;
  if (!row) return null;
  return {
    data: parseStringRecord(row.latest_data_json),
    ...(row.latest_error ? { error: row.latest_error } : {}),
  };
}

function parseStringRecord(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
      else if (value !== undefined && value !== null) out[key] = String(value);
    }
    return out;
  } catch {
    return {};
  }
}

function sqliteTaskStatus(task: TaskRow): "done" | "failed" | null {
  if (task.state === "done") return "done";
  if (task.state === "failed" || task.state === "cancelled" || task.state === "blocked") return "failed";
  return null;
}

function findBlockedParent(taskStore: ReturnType<typeof createTaskStore>, tasks: TaskRow[]): TaskRow | null {
  for (const task of tasks) {
    const rows = taskStore.db.prepare(`
      SELECT parent_task_id
      FROM task_dependencies
      WHERE child_task_id = ?
    `).all(task.taskId) as Array<{ parent_task_id: string }>;
    for (const row of rows) {
      const parent = taskStore.getTask(row.parent_task_id);
      if (parent?.state === "blocked" || parent?.state === "failed" || parent?.state === "cancelled") return parent;
    }
  }
  return null;
}

function rejectIfDiscardRequested(opts: WatchChildRunsOpts): void {
  if (opts.shouldAbort?.()) throw createOperatorDiscardError();
}

export async function watchChildRuns(opts: WatchChildRunsOpts): Promise<ChildOutcome[]> {
  const dir = opts.trackerDir ?? ".tracker";
  const date = opts.date ?? dateLocal();
  const sqliteOutcomes = await maybeWatchSqliteChildRuns(opts, dir);
  if (sqliteOutcomes) return sqliteOutcomes;
  const file = join(dir, `${opts.workflow}-${date}.jsonl`);
  const expected = new Set(opts.expectedItemIds);
  const totalExpected = expected.size;
  const isTerminal =
    opts.isTerminal ?? ((e: TrackerEntry) => e.status === "done" || e.status === "failed");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const watchFile = opts.watcherFactory ?? fsWatch;

  const outcomes: ChildOutcome[] = [];
  let lastSize = 0;
  /** Incomplete UTF-8 line prefix from the last incremental read. */
  let utf8Pending = "";

  return new Promise<ChildOutcome[]>((resolve, reject) => {
    let finalized = false;
    let watcher: ReturnType<typeof fsWatch> | undefined;
    let watcherCreationFailed = false;
    let watcherCreationRetryAt = 0;
    const abortCache: { current: AbortFileCache | null } = { current: null };

    const cleanup = (): void => {
      finalized = true;
      try { watcher?.close(); } catch { /* ignore */ }
      clearInterval(pollHandle);
      clearTimeout(timeoutHandle);
    };

    const ingestLines = (lines: string[]): void => {
      for (const line of lines) {
        if (!line) continue;
        let entry: TrackerEntry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!entry.id || !expected.has(entry.id)) continue;
        if (!isTerminal(entry)) continue;
        const outcome: ChildOutcome = {
          workflow: entry.workflow,
          itemId: entry.id,
          runId: entry.runId ?? "",
          status: entry.status as "done" | "failed",
          data: entry.data,
          error: entry.error,
        };
        outcomes.push(outcome);
        expected.delete(entry.id);
        const remaining = totalExpected - outcomes.length;
        if (opts.onProgress) {
          try { opts.onProgress(outcome, remaining); } catch { /* swallow */ }
        }
      }
    };

    const checkFile = (): void => {
      if (finalized) return;
      try {
        rejectIfDiscardRequested(opts);
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (!existsSync(file)) return;
      let cur;
      try {
        cur = statSync(file);
      } catch {
        return;
      }
      if (cur.size < lastSize) {
        lastSize = 0;
        utf8Pending = "";
      }
      if (cur.size <= lastSize) return;

      try {
        const fd = openSync(file, "r");
        try {
          const byteLen = cur.size - lastSize;
          const buf = Buffer.alloc(byteLen);
          let total = 0;
          while (total < byteLen) {
            const n = readSync(fd, buf, total, byteLen - total, lastSize + total);
            if (n === 0) break;
            total += n;
          }
          const chunk = buf.subarray(0, total).toString("utf8");
          const combined = utf8Pending + chunk;
          const lastNl = combined.lastIndexOf("\n");
          if (lastNl === -1) {
            utf8Pending = combined;
          } else {
            const complete = combined.slice(0, lastNl + 1);
            utf8Pending = combined.slice(lastNl + 1);
            ingestLines(complete.split("\n"));
          }
        } finally {
          closeSync(fd);
        }
      } catch {
        return;
      }

      lastSize = cur.size;
      if (expected.size === 0) {
        cleanup();
        resolve(outcomes);
      }
    };

    const checkAbort = (): void => {
      if (finalized) return;
      try {
        rejectIfDiscardRequested(opts);
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      const sentinel = opts.abortIfRowState;
      if (!sentinel) return;
      if (!readAbortRequestedCached(opts, dir, date, abortCache)) return;
      cleanup();
      reject(new Error(
        `watchChildRuns aborted by parent row state (${sentinel.workflow}/${sentinel.id} step="${sentinel.step}")`,
      ));
    };

    const timeoutHandle = setTimeout(() => {
      if (finalized) return;
      cleanup();
      const stillWaiting = Array.from(expected).join(", ");
      reject(new Error(`watchChildRuns timeout (${timeoutMs}ms) — still waiting for: ${stillWaiting}`));
    }, timeoutMs);
    timeoutHandle.unref?.();

    const maybeCreateWatcher = (): void => {
      if (watcher || !existsSync(file)) return;
      const now = Date.now();
      if (watcherCreationFailed && now < watcherCreationRetryAt) return;
      try {
        watcher = watchFile(file, { persistent: false }, () => checkFile());
        watcherCreationFailed = false;
        watcherCreationRetryAt = 0;
      } catch (err) {
        watcherCreationFailed = true;
        watcherCreationRetryAt = now + 30_000;
        log.warn(`watch-child-runs: fsWatch creation failed for ${file}: ${errorMessage(err)}`);
      }
    };

    const pollHandle = setInterval(() => {
      checkFile();
      checkAbort();
      maybeCreateWatcher();
    }, WATCH_CHILD_POLL_MS);
    pollHandle.unref?.();

    maybeCreateWatcher();

    checkFile();
    if (finalized) return;
    checkAbort();
  });
}
