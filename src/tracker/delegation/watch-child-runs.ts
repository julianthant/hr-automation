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
  existsSync,
  statSync,
  watch as fsWatch,
} from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { TrackerEntry } from "../jsonl.js";
import { rowFilePath } from "../paths.js";
import { makeTailState, tailIncremental, type TailState } from "../tail-incremental.js";
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
  /** The full TrackerEntry that triggered terminal classification. Always set by watchChildRuns; optional for test mocks. */
  terminalEntry?: TrackerEntry;
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
    /** Also abort when the matching entry carries this status value. */
    status?: string;
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
  tailState: TailState;
  lastStepForId: string | undefined;
  lastStatusForId: string | undefined;
}

function readAbortRequestedCached(
  opts: WatchChildRunsOpts,
  dir: string,
  date: string,
  cache: { current: AbortFileCache | null },
): boolean {
  if (!opts.abortIfRowState) return false;
  const sentinel = opts.abortIfRowState;
  const abortFile = rowFilePath(sentinel.workflow, date, dir);
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

  const sameFile = prev?.path === abortFile;
  const tailState = sameFile && prev ? prev.tailState : makeTailState();
  let lastStepForId = sameFile && prev ? prev.lastStepForId : undefined;
  let lastStatusForId = sameFile && prev ? prev.lastStatusForId : undefined;
  if (sameFile && prev && st.size < prev.tailState.lastSize) {
    lastStepForId = undefined;
    lastStatusForId = undefined;
  }

  for (const line of tailIncremental(abortFile, tailState)) {
    let entry: TrackerEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.id !== sentinel.id) continue;
    lastStepForId = entry.step;
    lastStatusForId = entry.status;
  }

  const result =
    lastStepForId === sentinel.step ||
    (sentinel.status !== undefined && lastStatusForId === sentinel.status);
  cache.current = {
    path: abortFile,
    size: st.size,
    mtimeMs: st.mtimeMs,
    result,
    tailState,
    lastStepForId,
    lastStatusForId,
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
  const isTerminalFn = opts.isTerminal ?? ((e: TrackerEntry) => e.status === "done" || e.status === "failed");

  try {
    for (;;) {
      rejectIfDiscardRequested(opts);
      if (readAbortRequestedCached(opts, dir, dateForAbort, abortCache)) {
        throw new Error(
          `watchChildRuns aborted by parent row state (${opts.abortIfRowState!.workflow}/${opts.abortIfRowState!.id} step="${opts.abortIfRowState!.step}")`,
        );
      }

      // --- 3 IN-list queries per tick (was 3N) ---

      // Query 1: batch-fetch fresh task states for all unseen tasks.
      const pendingTasks = tasks.filter((t) => !seen.has(t.itemId));
      const freshMap = batchGetTaskStates(taskStore.db, pendingTasks.map((t) => t.taskId));

      // Collect newly terminal items.
      const newlyTerminal: Array<{ itemId: string; workflow: string; runId: string | null; state: string; error: string | null }> = [];
      for (const task of pendingTasks) {
        const fresh = freshMap.get(task.taskId);
        if (!fresh || !sqliteTaskStatus(fresh)) continue;
        newlyTerminal.push(fresh);
      }

      // Query 2: batch-fetch projection data for terminal items.
      const projectionMap = newlyTerminal.length > 0
        ? batchGetItemProjections(taskStore.db, opts.workflow, newlyTerminal.map((f) => f.itemId))
        : new Map<string, { data: Record<string, string>; error?: string }>();

      for (const fresh of newlyTerminal) {
        const status = sqliteTaskStatus(fresh)!;
        const projected = projectionMap.get(fresh.itemId) ?? null;
        const synthetic: TrackerEntry = {
          workflow: fresh.workflow,
          id: fresh.itemId,
          runId: fresh.runId ?? undefined,
          timestamp: new Date().toISOString(),
          status,
          data: projected?.data ?? {},
          error: projected?.error ?? (fresh.error ?? undefined),
        };
        if (!isTerminalFn(synthetic)) continue;
        const outcome: ChildOutcome = {
          workflow: fresh.workflow,
          itemId: fresh.itemId,
          runId: fresh.runId ?? "",
          status,
          data: synthetic.data,
          error: synthetic.error,
          terminalEntry: synthetic,
        };
        outcomes.push(outcome);
        seen.add(fresh.itemId);
        opts.onProgress?.(outcome, tasks.length - outcomes.length);
      }

      if (seen.size === tasks.length) return outcomes;

      // Query 3: batch-check whether any pending task has a blocked/failed parent.
      const remainingTaskIds = tasks.filter((t) => !seen.has(t.itemId)).map((t) => t.taskId);
      const blockedParentId = findBlockedParentBatch(taskStore.db, remainingTaskIds);
      if (blockedParentId) {
        throw new Error(`watchChildRuns blocked by parent task ${blockedParentId}`);
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

interface FreshTaskState {
  taskId: string;
  itemId: string;
  workflow: string;
  runId: string | null;
  state: string;
  error: string | null;
}

function batchGetTaskStates(
  db: ReturnType<typeof createTaskStore>["db"],
  taskIds: string[],
): Map<string, FreshTaskState> {
  if (taskIds.length === 0) return new Map();
  const placeholders = taskIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT id, item_id, workflow, run_id, control_state, terminal_error FROM tasks WHERE id IN (${placeholders})`,
  ).all(...taskIds) as Array<{
    id: string;
    item_id: string;
    workflow: string;
    run_id: string | null;
    control_state: string | null;
    terminal_error: string | null;
  }>;
  const out = new Map<string, FreshTaskState>();
  for (const row of rows) {
    out.set(row.id, {
      taskId: row.id,
      itemId: row.item_id,
      workflow: row.workflow,
      runId: row.run_id,
      state: row.control_state ?? "queued",
      error: row.terminal_error,
    });
  }
  return out;
}

function batchGetItemProjections(
  db: ReturnType<typeof createTaskStore>["db"],
  workflow: string,
  itemIds: string[],
): Map<string, { data: Record<string, string>; error?: string }> {
  if (itemIds.length === 0) return new Map();
  const placeholders = itemIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT item_id, latest_data_json, latest_error FROM items WHERE workflow = ? AND item_id IN (${placeholders})`,
  ).all(workflow, ...itemIds) as Array<{
    item_id: string;
    latest_data_json: string | null;
    latest_error: string | null;
  }>;
  const out = new Map<string, { data: Record<string, string>; error?: string }>();
  for (const row of rows) {
    out.set(row.item_id, {
      data: parseStringRecord(row.latest_data_json, `item ${row.item_id} (workflow ${workflow})`),
      ...(row.latest_error ? { error: row.latest_error } : {}),
    });
  }
  return out;
}

function findBlockedParentBatch(
  db: ReturnType<typeof createTaskStore>["db"],
  taskIds: string[],
): string | null {
  if (taskIds.length === 0) return null;
  const placeholders = taskIds.map(() => "?").join(", ");
  const row = db.prepare(`
    SELECT t.id AS task_id
    FROM task_dependencies td
    JOIN tasks t ON t.id = td.parent_task_id
    WHERE td.child_task_id IN (${placeholders})
      AND t.control_state IN ('blocked', 'failed', 'cancelled')
    LIMIT 1
  `).get(...taskIds) as { task_id: string } | undefined;
  return row ? row.task_id : null;
}

function parseStringRecord(raw: string | null, context?: string): Record<string, string> {
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
  } catch (err) {
    log.warn(
      `watch-child-runs: failed to parse stored data JSON${context ? ` for ${context}` : ""}: ${errorMessage(err)}`,
    );
    return {};
  }
}

function sqliteTaskStatus(task: { state: string }): "done" | "failed" | null {
  if (task.state === "done") return "done";
  if (task.state === "failed" || task.state === "cancelled" || task.state === "blocked") return "failed";
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
  const file = rowFilePath(opts.workflow, date, dir);
  const expected = new Set(opts.expectedItemIds);
  const totalExpected = expected.size;
  const isTerminal =
    opts.isTerminal ?? ((e: TrackerEntry) => e.status === "done" || e.status === "failed");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const watchFile = opts.watcherFactory ?? fsWatch;

  const outcomes: ChildOutcome[] = [];
  const tailState = makeTailState();

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
          terminalEntry: entry,
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
      ingestLines(tailIncremental(file, tailState));

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
