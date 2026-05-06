/**
 * Handler factories for the dashboard's operational endpoints — retry,
 * edit-and-resume, queue mutations, and daemon ops. All workflow-agnostic;
 * each handler takes a `workflow` param and operates on SQLite control rows,
 * tracker JSONL, and daemon lockfiles keyed by that workflow.
 *
 * Factored out of dashboard.ts so the route bodies in that file stay short
 * and so each handler can be unit-tested with a fake `dir` argument
 * (mirroring `buildSelectorWarningsHandler`, `buildSearchHandler`, etc.).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { mkdir, rmdir } from "fs/promises";
import { setTimeout as delay } from "timers/promises";
import { request as httpRequest } from "http";
import { appendLogEntry, readEntries, readEntriesForDate, listDatesForWorkflow, trackEvent, type TrackerEntry } from "./jsonl.js";
import {
  findAliveDaemons,
  spawnDaemon,
  daemonsDir,
} from "../core/daemon-registry.js";
import { queueFilePath, queueLockDirPath } from "../core/daemon-queue.js";
import type { QueueEvent, Daemon } from "../core/daemon-types.js";
import { enqueueFromHttp } from "../core/enqueue-dispatch.js";
import { stopDaemons } from "../core/daemon-client.js";
import { openControlDb } from "../core/control-db.js";
import { cancelInProcessRun } from "../core/in-process-runs.js";
import { createTaskStore, type ControlTaskStore, type TaskRow } from "../core/task-store.js";
import { createWorkerStore, type BrowserProcessRow, type ControlWorkerStore, type WorkerRow } from "../core/worker-store.js";
import { findInputForRetry } from "../core/find-input.js";
import { log } from "../utils/log.js";
import { join } from "path";

const DASHBOARD_CANCEL_ERROR = "cancelled by user from dashboard";

function openControlStores(dir: string): {
  taskStore: ControlTaskStore;
  workerStore: ControlWorkerStore;
  close: () => void;
} {
  const control = openControlDb({ trackerDir: dir });
  return {
    taskStore: createTaskStore(control),
    workerStore: createWorkerStore(control),
    // openStateDb caches one connection per tracker directory. Dashboard
    // request helpers must not close it out from under other stores in the
    // same process.
    close: () => {},
  };
}

function resolveControlTask(
  taskStore: ControlTaskStore,
  workflow: string,
  id: string,
  runId?: string,
): TaskRow | null {
  const task = runId
    ? taskStore.getTaskByRunId(runId)
    : taskStore.findTaskByIdentity({ workflow, itemId: id });
  if (!task) return null;
  if (task.workflow !== workflow || task.itemId !== id) return null;
  return task;
}

function appendQueueAudit(workflow: string, event: QueueEvent, dir: string): void {
  mkdirSync(daemonsDir(dir), { recursive: true });
  appendFileSync(queueFilePath(workflow, dir), JSON.stringify(event) + "\n");
}

function appendQueueFailedAudit(
  workflow: string,
  id: string,
  runId: string | undefined,
  error: string,
  dir: string,
): void {
  appendQueueAudit(
    workflow,
    {
      type: "failed",
      id,
      failedAt: new Date().toISOString(),
      runId: runId ?? "",
      error,
    },
    dir,
  );
}

function appendQueueEnqueueAudit(
  workflow: string,
  id: string,
  input: unknown,
  runId: string,
  dir: string,
): void {
  appendQueueAudit(
    workflow,
    {
      type: "enqueue",
      id,
      workflow,
      input,
      enqueuedAt: new Date().toISOString(),
      enqueuedBy: "dashboard",
      runId,
    },
    dir,
  );
}

function emitDashboardCancelTrackerRow(
  workflow: string,
  id: string,
  runId: string | undefined,
  dir: string,
): void {
  const ts = new Date().toISOString();
  trackEvent(
    {
      workflow,
      timestamp: ts,
      id,
      runId,
      status: "failed",
      step: "cancelled",
      error: DASHBOARD_CANCEL_ERROR,
    },
    dir,
  );
  appendLogEntry(
    {
      workflow,
      itemId: id,
      runId,
      level: "warn",
      message: `Dashboard cancellation: ${DASHBOARD_CANCEL_ERROR}`,
      ts,
    },
    dir,
  );
}

function emitDashboardCancelRequestedLog(
  workflow: string,
  id: string,
  runId: string,
  dir: string,
): void {
  appendLogEntry(
    {
      workflow,
      itemId: id,
      runId,
      level: "warn",
      message: "Cancellation requested by dashboard; waiting for the worker to stop this run.",
      ts: new Date().toISOString(),
    },
    dir,
  );
}

function currentAttemptWorker(
  taskStore: ControlTaskStore,
  workerStore: ControlWorkerStore,
  task: TaskRow,
): { workerId?: string; attemptId?: string } {
  const attemptId = task.currentAttemptId;
  const attempt = attemptId ? taskStore.getAttempt(attemptId) : null;
  const owner = workerStore.findWorkerOwnerByTask({
    taskId: task.taskId,
    ...(attemptId ? { attemptId } : {}),
  });
  return {
    workerId: task.claimedByWorkerId ?? attempt?.workerId ?? owner?.workerId,
    ...(attemptId ? { attemptId } : {}),
  };
}

function signalBrowserPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* best-effort hard-control fallback */
  }
}

async function requestDaemonForceCurrent(
  worker: WorkerRow | null,
  itemId: string,
  runId: string | undefined,
): Promise<boolean> {
  if (!worker?.port || !runId) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${worker.port}/force-current`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId, runId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function requestDaemonStopWorker(worker: WorkerRow | null): Promise<boolean> {
  if (!worker?.port) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${worker.port}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Lookup an entry's input by (workflow, id, runId?). Delegates to the
 * canonical three-tier lookup in `src/core/find-input.ts` and reshapes
 * the result into the `{input} | {error}` shape consumed by `reEnqueueEntry`.
 */
export function findEntryInput(
  workflow: string,
  id: string,
  runId: string | undefined,
  dir: string,
): { input: Record<string, unknown> } | { error: string } {
  const input = findInputForRetry(workflow, id, runId, dir);
  if (input) return { input };

  const entries = readEntries(workflow, dir).filter((e) => {
    if (e.id !== id) return false;
    if (runId && e.runId !== runId) return false;
    return true;
  });
  if (entries.length === 0) {
    return { error: `no tracker entry found for id=${id}` };
  }
  return { error: "no input or data found to reconstruct retry payload" };
}

function asRecordInput(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
}

/**
 * Merged accumulated `data` for an id across every tracker row (any status).
 * Used by edit-and-resume to seed prefilledData with non-editable fields
 * carried over from prior runs (e.g. separations' rawTerminationType,
 * deptId, departmentDescription).
 *
 * Implementation: oldest → newest fold, latest non-empty value wins per
 * key. Replaces the prior "latest row's data only" lookup, which broke
 * lineage when the latest row was a cancel-queued synthetic failed entry
 * or a /api/save-data persist that only carried the editable subset of
 * fields. With the merge, even if a later row drops a key, the most
 * recent non-empty value from any earlier row is preserved.
 *
 * Excludes kernel-internal keys (`__name`, `__id`, `instance`) so those
 * don't leak into a fresh run's prefilledData channel.
 */
export function findLatestEntryData(
  workflow: string,
  id: string,
  dir: string,
): Record<string, string> {
  const entries = readEntries(workflow, dir).filter((e) => e.id === id && e.data);
  if (entries.length === 0) return {};
  // Ascending sort so later non-empty values overwrite earlier ones per key.
  entries.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  const merged: Record<string, string> = {};
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.data ?? {})) {
      if (k === "__name" || k === "__id" || k === "instance") continue;
      if (v === undefined || v === null || v === "") continue;
      merged[k] = String(v);
    }
  }
  return merged;
}

export interface RetryRequest {
  workflow: string;
  id: string;
  runId?: string;
}

export interface RunWithDataRequest {
  workflow: string;
  id: string;
  data: Record<string, unknown>;
  runId?: string;
}

export interface RetryBulkRequest {
  workflow: string;
  ids: string[];
}

type ReEnqueueResult = { ok: true } | { ok: false; error: string };

/** In-process workflows that don't run via the daemon queue — retry routes
 * through their existing in-process launchers instead of `enqueueFromHttp`.
 * See `src/workflows/CLAUDE.md` ("Existing Workflows" table) for the
 * non-daemon rationale. */
const IN_PROCESS_WORKFLOWS = new Set(["ocr", "sharepoint-download"]);

/**
 * Re-enqueue a tracker entry — the shared core of `/api/retry` and
 * `/api/run-with-data`. Looks up the original input, optionally attaches a
 * `prefilledData` channel (edit-and-resume), and dispatches via the same
 * daemon path the CLI uses. The kernel auto-increments runId so the new run
 * shows up as a fresh row in the dashboard's RunSelector. Reuses an alive
 * daemon when one exists; spawns a fresh one when none do.
 *
 * `prefilledData` is the only difference between retry (omit) and edit-and-
 * resume (provide user edits). When provided, it's merged with the previous
 * run's accumulated data so non-editable fields (e.g. separations'
 * `rawTerminationType` — used by downstream `mapReasonCode` but not surfaced
 * as an editable detail field) carry over and the handler's gating check
 * sees the full set of required fields. The user's edits win on collision.
 *
 * In-process workflows (`ocr`, `sharepoint-download`) bypass the daemon path
 * — they aren't registered in `WORKFLOW_LOADERS` because they run inside the
 * dashboard's Node process via fire-and-forget `runWorkflow`. Retry for them
 * fires their existing HTTP-shaped launchers directly. `prefilledData` is
 * ignored for these workflows since neither has user-editable inputs.
 */
async function reEnqueueEntry(
  workflow: string,
  id: string,
  runId: string | undefined,
  prefilledData: Record<string, unknown> | undefined,
  dir: string,
): Promise<ReEnqueueResult> {
  // Tolerate trailing slash from URL-shaped workflow values that occasionally
  // leak in from clients that build paths instead of identifiers.
  const wf = workflow.trim().replace(/\/+$/, "");
  if (!wf || !id) return { ok: false, error: "workflow and id are required" };

  if (runId && !prefilledData) {
    const stores = openControlStores(dir);
    try {
      const task = resolveControlTask(stores.taskStore, wf, id, runId);
      if (task) {
        const input = asRecordInput(task.input);
        if (!input) {
          return { ok: false, error: "stored task input is unavailable for retry" };
        }
        const retried = stores.taskStore.retryTaskFromAttempt({ runId });
        stores.workerStore.enqueueWorkerCommand({
          commandType: "retry_task",
          workflow: wf,
          targetTaskId: retried.taskId,
          targetAttemptId: retried.attemptId,
          state: "completed",
          payload: { fromRunId: runId, runId: retried.runId },
        });
        appendQueueEnqueueAudit(wf, retried.itemId, input, retried.runId, dir);
        trackEvent(
          {
            workflow: wf,
            timestamp: new Date().toISOString(),
            id: retried.itemId,
            runId: retried.runId,
            status: "pending",
            input,
          },
          dir,
        );
        return { ok: true };
      }
    } finally {
      stores.close();
    }
  }

  if (IN_PROCESS_WORKFLOWS.has(wf)) {
    return reEnqueueInProcessEntry(wf, id, runId, dir);
  }

  const lookup = findEntryInput(wf, id, runId, dir);
  if ("error" in lookup) return { ok: false, error: lookup.error };

  let input: Record<string, unknown> = lookup.input;
  if (prefilledData) {
    const previousData = findLatestEntryData(wf, id, dir);
    input = { ...input, prefilledData: { ...previousData, ...prefilledData } };
  }

  const result = await enqueueFromHttp(wf, [input], dir);
  if (!result.ok) return { ok: false, error: result.error ?? "enqueue failed" };
  return { ok: true };
}

/** Retry for in-process workflows — dispatches to the same launcher their
 * original HTTP entry point uses. */
async function reEnqueueInProcessEntry(
  workflow: string,
  id: string,
  runId: string | undefined,
  dir: string,
): Promise<ReEnqueueResult> {
  if (workflow === "ocr") return reEnqueueOcrEntry(id, runId, dir);
  if (workflow === "sharepoint-download") return reEnqueueSharePointEntry(id, runId, dir);
  return { ok: false, error: `in-process retry not implemented for "${workflow}"` };
}

async function reEnqueueOcrEntry(
  id: string,
  runId: string | undefined,
  dir: string,
): Promise<ReEnqueueResult> {
  // The OCR orchestrator only writes pdfPath/pdfOriginalName on the pending
  // row — later rows (loading-roster, ocr, awaiting-approval, failed) drop
  // them. findEntryInput's latest-row fallback would miss them, so merge
  // across every row for this id and keep the latest non-empty value per key.
  const entries = readEntries("ocr", dir).filter((e) => e.id === id);
  if (entries.length === 0) {
    return { ok: false, error: `no tracker entry found for id=${id}` };
  }
  const matching = runId ? entries.filter((e) => e.runId === runId) : entries;
  if (matching.length === 0) {
    return { ok: false, error: `no tracker entry found for id=${id} runId=${runId}` };
  }
  const merged: Record<string, string> = {};
  [...matching].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1)).forEach((e) => {
    for (const [k, v] of Object.entries(e.data ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      merged[k] = String(v);
    }
  });

  const pdfPath = merged.pdfPath ?? "";
  const pdfOriginalName = merged.pdfOriginalName ?? "";
  const formType = merged.formType ?? "";
  const sessionId = merged.sessionId || id;
  const rosterModeRaw = merged.rosterMode ?? "existing";
  const rosterMode: "existing" | "download" =
    rosterModeRaw === "download" ? "download" : "existing";
  const rosterPath = merged.rosterPath || undefined;

  if (!pdfPath || !pdfOriginalName || !formType) {
    return {
      ok: false,
      error: "OCR retry: entry data missing pdfPath/pdfOriginalName/formType",
    };
  }
  if (!existsSync(pdfPath)) {
    return { ok: false, error: `OCR retry: PDF no longer exists at ${pdfPath}` };
  }

  const { buildOcrPrepareHandler } = await import("./ocr-http.js");
  const handler = buildOcrPrepareHandler({ trackerDir: dir });
  const result = await handler({
    pdfPath,
    pdfOriginalName,
    formType,
    sessionId,
    rosterMode,
    ...(rosterPath ? { rosterPath } : {}),
  });
  if (!result.body.ok) return { ok: false, error: result.body.error };
  return { ok: true };
}

async function reEnqueueSharePointEntry(
  id: string,
  runId: string | undefined,
  dir: string,
): Promise<ReEnqueueResult> {
  const lookup = findEntryInput("sharepoint-download", id, runId, dir);
  // Fall back to the entry id when input lookup fails — sharepoint-download
  // uses the spec id as the tracker id, so we can launch a retry from id alone.
  const specId =
    "input" in lookup && typeof lookup.input.id === "string" && lookup.input.id
      ? lookup.input.id
      : id;
  if (!specId) {
    return { ok: false, error: "sharepoint-download retry: missing spec id" };
  }

  const { buildSharePointRosterDownloadHandler } = await import(
    "../workflows/sharepoint-download/handler.js"
  );
  const handler = buildSharePointRosterDownloadHandler();
  const result = await handler({ id: specId });
  if (!result.body.ok) return { ok: false, error: result.body.error };
  return { ok: true };
}

export function buildRetryHandler(dir: string) {
  return (req: RetryRequest): Promise<ReEnqueueResult> =>
    reEnqueueEntry(req.workflow, req.id, req.runId, undefined, dir);
}

export function buildRunWithDataHandler(dir: string) {
  return (req: RunWithDataRequest): Promise<ReEnqueueResult> => {
    if (!req.data || typeof req.data !== "object") {
      return Promise.resolve({ ok: false, error: "data is required" });
    }
    return reEnqueueEntry(req.workflow, req.id, req.runId, req.data, dir);
  };
}

export function buildRetryBulkHandler(dir: string) {
  const retry = buildRetryHandler(dir);
  return async (
    req: RetryBulkRequest,
  ): Promise<{ ok: true; count: number; errors: Array<{ id: string; error: string }> }> => {
    const errors: Array<{ id: string; error: string }> = [];
    let count = 0;
    for (const id of req.ids ?? []) {
      const r = await retry({ workflow: req.workflow, id });
      if (r.ok) count++;
      else errors.push({ id, error: r.error });
    }
    return { ok: true, count, errors };
  };
}

export interface SaveDataRequest {
  workflow: string;
  id: string;
  data: Record<string, unknown>;
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

export interface CancelQueuedRequest {
  workflow: string;
  id: string;
  runId?: string;
}

/**
 * Cancel a queued item. SQLite-backed tasks are cancelled in the task/attempt
 * tables and mirrored to JSONL audit + tracker; the queue-file mutation below
 * remains only for migration fallback rows with no task record.
 */
export function buildCancelQueuedHandler(dir: string) {
  return async (
    req: CancelQueuedRequest,
  ): Promise<{ ok: true } | { ok: false; error: string; status?: number }> => {
    if (!req.workflow || !req.id) return { ok: false, error: "workflow and id are required" };
    const stores = openControlStores(dir);
    try {
      const task = resolveControlTask(stores.taskStore, req.workflow, req.id, req.runId);
      if (task) {
        if (task.state === "claimed" || task.state === "running" || task.state === "cancel_requested" || task.state === "cancelling") {
          return {
            ok: false as const,
            error: "item already claimed by a daemon — use cancel running",
            status: 409,
          };
        }
        if (task.state === "done" || task.state === "failed" || task.state === "cancelled") {
          return { ok: false as const, error: `item is already ${task.state}`, status: 410 };
        }
        if (task.state !== "queued") {
          return { ok: false as const, error: `cannot cancel item in state ${task.state}`, status: 409 };
        }
        stores.workerStore.enqueueWorkerCommand({
          commandType: "cancel_task",
          workflow: req.workflow,
          targetTaskId: task.taskId,
          ...(task.currentAttemptId ? { targetAttemptId: task.currentAttemptId } : {}),
          state: "completed",
          payload: { itemId: req.id, runId: req.runId ?? task.currentRunId ?? task.runId },
        });
        stores.taskStore.markTaskCancelled({
          taskId: task.taskId,
          ...(task.currentAttemptId ? { attemptId: task.currentAttemptId } : {}),
          reason: DASHBOARD_CANCEL_ERROR,
        });
        stores.taskStore.markDependencyFromChildTerminal({
          childTaskId: task.taskId,
          childState: "cancelled",
        });
        const auditRunId = req.runId ?? task.currentRunId ?? task.runId;
        appendQueueFailedAudit(req.workflow, req.id, auditRunId, DASHBOARD_CANCEL_ERROR, dir);
        emitDashboardCancelTrackerRow(req.workflow, req.id, auditRunId, dir);
        return { ok: true as const };
      }
    } finally {
      stores.close();
    }
    return withQueueLock(req.workflow, dir, async () => {
      const path = queueFilePath(req.workflow, dir);
      if (!existsSync(path)) return { ok: false as const, error: "queue file does not exist" };
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n").filter((l) => l.trim());
      // Determine current state of the requested id by folding events.
      let state: "queued" | "claimed" | "done" | "failed" | "missing" = "missing";
      let runId: string | undefined;
      for (const line of lines) {
        let ev: QueueEvent;
        try {
          ev = JSON.parse(line) as QueueEvent;
        } catch {
          continue;
        }
        if (!ev || (ev as { id?: string }).id !== req.id) continue;
        if (ev.type === "enqueue") {
          state = "queued";
          runId = ev.runId;
        } else if (ev.type === "claim") {
          state = "claimed";
          runId = ev.runId;
        } else if (ev.type === "unclaim") {
          state = "queued";
        } else if (ev.type === "done") {
          state = "done";
        } else if (ev.type === "failed") {
          state = "failed";
        }
      }
      if (state === "missing") return { ok: false as const, error: "id not found in queue", status: 404 };
      if (state === "claimed") {
        return {
          ok: false as const,
          error: "item already claimed by a daemon — cannot cancel",
          status: 409,
        };
      }
      if (state === "done" || state === "failed") {
        return { ok: false as const, error: `item is already ${state}`, status: 410 };
      }
      // Append a synthetic `failed` queue event so the queue fold sees it
      // as terminal. We use `failed` (not a new `cancel` type) so existing
      // QueueEvent unions stay closed and readers don't need updating.
      const cancelEvent: QueueEvent = {
        type: "failed",
        id: req.id,
        failedAt: new Date().toISOString(),
        runId: runId ?? "",
        error: DASHBOARD_CANCEL_ERROR,
      };
      writeFileSync(path, text.endsWith("\n") || text === "" ? text : text + "\n", { flag: "w" });
      // Use append-style write — the lock guarantees exclusion.
      writeFileSync(path, JSON.stringify(cancelEvent) + "\n", { flag: "a" });

      // Mirror the cancellation onto tracker + logs so selecting the row
      // never lands on an unexplained "No logs yet" panel.
      emitDashboardCancelTrackerRow(req.workflow, req.id, runId, dir);
      return { ok: true as const };
    });
  };
}

export interface CancelRunningRequest {
  workflow: string;
  id: string;
  runId: string;
}

export type CancelRunningResult =
  | { ok: true; accepted: true; mode: "worker-command"; commandId: string }
  | { ok: true; accepted: true; mode: "in-process"; alreadyCancelled?: boolean }
  | { ok: false; error: string; status?: number };

export function buildCancelRunningHandler(dir: string) {
  return async (req: CancelRunningRequest): Promise<CancelRunningResult> => {
    if (!req.workflow || !req.id || !req.runId) {
      return { ok: false, error: "workflow, id, runId are required", status: 400 };
    }
    const stores = openControlStores(dir);
    try {
      const task = resolveControlTask(stores.taskStore, req.workflow, req.id, req.runId);
      if (task) {
        if (task.state === "queued" || task.state === "waiting_dependencies" || task.state === "blocked") {
          return { ok: false, error: "item is queued — use cancel queued", status: 409 };
        }
        if (task.state === "done" || task.state === "failed" || task.state === "cancelled") {
          return { ok: false, error: `item is already ${task.state}`, status: 410 };
        }
        const { workerId, attemptId } = currentAttemptWorker(stores.taskStore, stores.workerStore, task);
        if (!workerId || !attemptId) {
          return { ok: false, error: "task has no owning worker", status: 410 };
        }
        stores.taskStore.requestCancelTask({
          taskId: task.taskId,
          reason: DASHBOARD_CANCEL_ERROR,
        });
        const commandId = stores.workerStore.enqueueWorkerCommand({
          commandType: "cancel_task",
          workflow: req.workflow,
          targetWorkerId: workerId,
          targetTaskId: task.taskId,
          targetAttemptId: attemptId,
          payload: { itemId: req.id, runId: req.runId },
        });
        emitDashboardCancelRequestedLog(req.workflow, req.id, req.runId, dir);
        return { ok: true, accepted: true, mode: "worker-command", commandId };
      }
    } finally {
      stores.close();
    }

    const inProcess = await cancelInProcessRun({
      workflow: req.workflow,
      itemId: req.id,
      runId: req.runId,
    });
    if (inProcess.ok) {
      emitDashboardCancelRequestedLog(req.workflow, req.id, req.runId, dir);
      return {
        ok: true,
        accepted: true,
        mode: "in-process",
        ...(inProcess.alreadyCancelled ? { alreadyCancelled: true } : {}),
      };
    }
    return {
      ok: false,
      error:
        "item not currently owned by any SQLite worker and no in-process run registered — likely already finished or never started",
      status: 410,
    };
  };
}

export interface ForceStopTaskRequest {
  workflow: string;
  id: string;
  runId?: string;
}

export function buildForceStopTaskHandler(dir: string) {
  return async (
    req: ForceStopTaskRequest,
  ): Promise<{ ok: true; commandId: string; killCommands: string[] } | { ok: false; error: string; status?: number }> => {
    if (!req.workflow || !req.id) return { ok: false, error: "workflow and id are required", status: 400 };
    const stores = openControlStores(dir);
    try {
      const task = resolveControlTask(stores.taskStore, req.workflow, req.id, req.runId);
      if (!task) return { ok: false, error: "task not found", status: 404 };
      const { workerId, attemptId } = currentAttemptWorker(stores.taskStore, stores.workerStore, task);
      const worker = workerId ? stores.workerStore.getWorker(workerId) : null;
      const runId = req.runId ?? task.currentRunId ?? task.runId;
      const commandId = stores.workerStore.enqueueWorkerCommand({
        commandType: "force_stop_task",
        workflow: req.workflow,
        ...(workerId ? { targetWorkerId: workerId } : {}),
        targetTaskId: task.taskId,
        ...(attemptId ? { targetAttemptId: attemptId } : {}),
        payload: { itemId: req.id, runId },
      });
      stores.taskStore.markTaskCancelled({
        taskId: task.taskId,
        ...(attemptId ? { attemptId } : {}),
        reason: DASHBOARD_CANCEL_ERROR,
      });
      stores.taskStore.markDependencyFromChildTerminal({
        childTaskId: task.taskId,
        childState: "cancelled",
      });
      appendQueueFailedAudit(req.workflow, req.id, runId, DASHBOARD_CANCEL_ERROR, dir);
      emitDashboardCancelTrackerRow(req.workflow, req.id, runId, dir);
      const daemonAccepted = await requestDaemonForceCurrent(worker, req.id, runId);
      const browsers = stores.workerStore.listBrowserProcessesForTask({
        taskId: task.taskId,
        ...(attemptId ? { attemptId } : {}),
      });
      const killCommands: string[] = [];
      for (const browser of browsers) {
        const killCommandId = enqueueKillBrowserCommand(stores.workerStore, browser);
        stores.workerStore.markBrowserProcessKillRequested({
          browserProcessId: browser.browserProcessId,
          commandId: killCommandId,
        });
        signalBrowserPid(browser.pid);
        killCommands.push(killCommandId);
      }
      if (!daemonAccepted && killCommands.length === 0) {
        log.warn(
          `[force-stop] task ${req.workflow}/${req.id} had no daemon force endpoint and no tracked browsers; marked cancelled in control state only`,
        );
      }
      return { ok: true, commandId, killCommands };
    } finally {
      stores.close();
    }
  };
}

export interface KillBrowserRequest {
  browserProcessId?: string;
  pid?: number;
}

export function buildKillBrowserHandler(dir: string) {
  return async (
    req: KillBrowserRequest,
  ): Promise<{ ok: true; commandId: string } | { ok: false; error: string; status?: number }> => {
    if (!req.browserProcessId && typeof req.pid !== "number") {
      return { ok: false, error: "browserProcessId or pid is required", status: 400 };
    }
    const stores = openControlStores(dir);
    try {
      const browser = req.browserProcessId
        ? stores.workerStore.findBrowserProcessById(req.browserProcessId)
        : stores.workerStore.findBrowserProcessByPid(req.pid!);
      if (!browser) return { ok: false, error: "browser process not found", status: 404 };
      const commandId = enqueueKillBrowserCommand(stores.workerStore, browser);
      stores.workerStore.markBrowserProcessKillRequested({
        browserProcessId: browser.browserProcessId,
        commandId,
      });
      signalBrowserPid(browser.pid);
      return { ok: true, commandId };
    } finally {
      stores.close();
    }
  };
}

function enqueueKillBrowserCommand(workerStore: ControlWorkerStore, browser: BrowserProcessRow): string {
  return workerStore.enqueueWorkerCommand({
    commandType: "kill_browser",
    workflow: browser.workflow,
    targetWorkerId: browser.workerId,
    ...(browser.taskId ? { targetTaskId: browser.taskId } : {}),
    ...(browser.attemptId ? { targetAttemptId: browser.attemptId } : {}),
    targetBrowserProcessId: browser.browserProcessId,
    payload: { pid: browser.pid, systemId: browser.systemId },
  });
}

export interface WorkerCommandRequest {
  workerId: string;
}

export function buildDrainWorkerHandler(dir: string) {
  return async (
    req: WorkerCommandRequest,
  ): Promise<{ ok: true; commandId: string } | { ok: false; error: string; status?: number }> =>
    enqueueWorkerLifecycleCommand(dir, req.workerId, "drain_worker");
}

export function buildStopWorkerHandler(dir: string) {
  return async (
    req: WorkerCommandRequest,
  ): Promise<{ ok: true; commandId: string } | { ok: false; error: string; status?: number }> =>
    enqueueWorkerLifecycleCommand(dir, req.workerId, "stop_worker");
}

async function enqueueWorkerLifecycleCommand(
  dir: string,
  workerId: string,
  commandType: "drain_worker" | "stop_worker",
): Promise<{ ok: true; commandId: string } | { ok: false; error: string; status?: number }> {
  if (!workerId) return { ok: false, error: "workerId is required", status: 400 };
  const stores = openControlStores(dir);
  try {
    const worker = stores.workerStore.getWorker(workerId);
    if (!worker) return { ok: false, error: "worker not found", status: 404 };
    const commandId = stores.workerStore.enqueueWorkerCommand({
      commandType,
      workflow: worker.workflow,
      targetWorkerId: worker.workerId,
      payload: { pid: worker.pid, instanceId: worker.instanceId },
    });
    if (commandType === "stop_worker") {
      void requestDaemonStopWorker(worker);
    }
    return { ok: true, commandId };
  } finally {
    stores.close();
  }
}

export interface QueueBumpRequest {
  workflow: string;
  id: string;
  runId?: string;
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

export interface DaemonInfo {
  workflow: string;
  workerId: string;
  pid: number;
  port: number | null;
  instanceId: string | null;
  startedAt: string;
  uptimeMs: number;
  itemsProcessed: number;
  currentItem: string | null;
  currentRunId: string | null;
  currentTaskId: string | null;
  currentAttemptId: string | null;
  phase: string;
  status: string;
  heartbeatAgeMs: number | null;
  browserProcesses: Array<{
    browserProcessId: string;
    systemId: string;
    pid: number;
    status: string;
  }>;
  lockfileAlive: boolean;
}

/** Probe a single daemon's /status endpoint with a short timeout. */
async function probeDaemonStatus(
  daemon: Daemon,
  timeoutMs = 1000,
): Promise<{ phase?: string; currentItem?: string | null; currentRunId?: string | null }> {
  return new Promise((resolve) => {
    const reqHttp = httpRequest(
      {
        host: "127.0.0.1",
        port: daemon.port,
        path: "/status",
        method: "GET",
        timeout: timeoutMs,
      },
      (resHttp) => {
        let body = "";
        resHttp.on("data", (chunk) => (body += chunk));
        resHttp.on("end", () => {
          try {
            const parsed = JSON.parse(body) as {
              phase?: string;
              inFlight?: string | { id?: string } | null;
              inFlightRunId?: string | null;
            };
            const currentItem =
              typeof parsed.inFlight === "string"
                ? parsed.inFlight
                : parsed.inFlight?.id ?? null;
            resolve({
              phase: parsed.phase,
              currentItem,
              currentRunId: parsed.inFlightRunId ?? null,
            });
          } catch {
            resolve({});
          }
        });
      },
    );
    reqHttp.on("error", () => resolve({}));
    reqHttp.on("timeout", () => {
      reqHttp.destroy();
      resolve({});
    });
    reqHttp.end();
  });
}

/** Count `done` + `failed` queue events whose `claimedBy === instanceId`. */
function countItemsProcessed(workflow: string, instanceId: string, dir: string): number {
  const path = queueFilePath(workflow, dir);
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  let count = 0;
  // We track which runIds were claimed by this instance, then count
  // terminal events for those runIds — `done` / `failed` events carry
  // `runId` but not `claimedBy`.
  const runIdsForInstance = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: QueueEvent;
    try {
      ev = JSON.parse(line) as QueueEvent;
    } catch {
      continue;
    }
    if (ev.type === "claim" && ev.claimedBy === instanceId) {
      runIdsForInstance.add(ev.runId);
    } else if ((ev.type === "done" || ev.type === "failed") && runIdsForInstance.has(ev.runId)) {
      count++;
    }
  }
  return count;
}

/**
 * List alive daemons across one or all workflows, enriched with per-daemon
 * runtime stats (uptime, itemsProcessed, current item, phase).
 */
export function buildDaemonsListHandler(dir: string) {
  return async (workflow?: string): Promise<DaemonInfo[]> => {
    const stores = openControlStores(dir);
    const lockfileWorkflows = discoverLockfileWorkflows(dir);
    for (const stale of stores.workerStore.listStaleWorkers({})) {
      if (workflow && stale.workflow !== workflow) continue;
      stores.workerStore.markWorkerStatus({
        workerId: stale.workerId,
        status: "stale",
        phase: stale.phase,
      });
    }
    const workers = stores.workerStore
      .listWorkers(workflow)
      .filter((worker) => worker.kind === "daemon" && (!workflow || worker.workflow === workflow));
    const workerWorkflows = new Set(workers.map((worker) => worker.workflow).filter(Boolean) as string[]);
    const workflows = workflow ? [workflow] : [...new Set([...lockfileWorkflows, ...workerWorkflows])];
    const out: DaemonInfo[] = [];
    const aliveByWorkflow = new Map<string, Daemon[]>();
    try {
      for (const wf of workflows) {
        aliveByWorkflow.set(wf, await findAliveDaemons(wf, dir));
      }
      for (const worker of workers) {
        const wf = worker.workflow ?? "";
        const alive = aliveByWorkflow.get(wf) ?? [];
        const matchingLock = alive.find((d) =>
          (worker.instanceId && d.instanceId === worker.instanceId) || d.pid === worker.pid
        );
        const terminalWithoutLiveLock =
          (worker.status === "dead" || worker.status === "stopped" || worker.status === "stale")
          && !matchingLock
          && !worker.currentTaskId
          && !worker.currentAttemptId;
        if (terminalWithoutLiveLock) continue;
        const currentTask = worker.currentTaskId ? stores.taskStore.getTask(worker.currentTaskId) : null;
        const currentAttempt = worker.currentAttemptId ? stores.taskStore.getAttempt(worker.currentAttemptId) : null;
        const browserProcesses = stores.workerStore.listBrowserProcessesForWorker(worker.workerId);
        out.push(workerToDaemonInfo({
          worker,
          matchingLock,
          currentItem: currentTask?.itemId ?? null,
          currentRunId: currentAttempt?.runId ?? currentTask?.currentRunId ?? currentTask?.runId ?? null,
          itemsProcessed: worker.instanceId ? countItemsProcessed(wf, worker.instanceId, dir) : 0,
          browserProcesses,
        }));
      }

      for (const wf of workflows) {
        const daemons = aliveByWorkflow.get(wf) ?? [];
        for (const d of daemons) {
          if (workers.some((worker) => worker.instanceId === d.instanceId || worker.pid === d.pid)) continue;
          const status = await probeDaemonStatus(d);
          out.push({
            workflow: d.workflow,
            workerId: d.instanceId,
            pid: d.pid,
            port: d.port,
            instanceId: d.instanceId,
            startedAt: d.startedAt,
            uptimeMs: Date.now() - new Date(d.startedAt).getTime(),
            itemsProcessed: countItemsProcessed(d.workflow, d.instanceId, dir),
            currentItem: status.currentItem ?? null,
            currentRunId: status.currentRunId ?? null,
            currentTaskId: null,
            currentAttemptId: null,
            phase: status.phase ?? "unknown",
            status: "alive",
            heartbeatAgeMs: null,
            browserProcesses: [],
            lockfileAlive: true,
          });
        }
      }
    } finally {
      stores.close();
    }
    return out;
  };
}

function discoverLockfileWorkflows(dir: string): string[] {
  const d = daemonsDir(dir);
  if (!existsSync(d)) return [];
  const names = new Set<string>();
  for (const file of readdirSync(d)) {
    if (!file.endsWith(".lock.json") || file.includes(".lock.json.tmp")) continue;
    try {
      const lock = JSON.parse(readFileSync(join(d, file), "utf-8")) as { workflow?: string };
      if (typeof lock.workflow === "string") names.add(lock.workflow);
    } catch { /* ignore unreadable / malformed */ }
  }
  return [...names];
}

function workerToDaemonInfo(args: {
  worker: WorkerRow;
  matchingLock?: Daemon;
  currentItem: string | null;
  currentRunId: string | null;
  itemsProcessed: number;
  browserProcesses: BrowserProcessRow[];
}): DaemonInfo {
  const { worker, matchingLock, browserProcesses } = args;
  const startedMs = Date.parse(worker.startedAt);
  const heartbeatMs = worker.lastHeartbeatAt ? Date.parse(worker.lastHeartbeatAt) : NaN;
  return {
    workflow: worker.workflow ?? "",
    workerId: worker.workerId,
    pid: worker.pid,
    port: worker.port ?? matchingLock?.port ?? null,
    instanceId: worker.instanceId ?? matchingLock?.instanceId ?? null,
    startedAt: worker.startedAt,
    uptimeMs: Number.isFinite(startedMs) ? Date.now() - startedMs : 0,
    itemsProcessed: args.itemsProcessed,
    currentItem: args.currentItem,
    currentRunId: args.currentRunId,
    currentTaskId: worker.currentTaskId ?? null,
    currentAttemptId: worker.currentAttemptId ?? null,
    phase: worker.phase,
    status: worker.status,
    heartbeatAgeMs: Number.isFinite(heartbeatMs) ? Date.now() - heartbeatMs : null,
    browserProcesses: browserProcesses.map((browser) => ({
      browserProcessId: browser.browserProcessId,
      systemId: browser.systemId,
      pid: browser.pid,
      status: browser.status,
    })),
    lockfileAlive: Boolean(matchingLock),
  };
}

export interface SpawnDaemonRequest {
  workflow: string;
  count?: number;
}

/**
 * Spawn N additional daemons for a workflow. Sequential — Duo isn't
 * parallelizable. `count` defaults to 1 (max 4 to prevent runaway spawns).
 */
export function buildDaemonsSpawnHandler(dir: string) {
  return async (
    req: SpawnDaemonRequest,
  ): Promise<{ ok: true; spawned: number } | { ok: false; error: string }> => {
    if (!req.workflow) return { ok: false, error: "workflow is required" };
    const count = Math.max(1, Math.min(4, req.count ?? 1));
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      try {
        await spawnDaemon(req.workflow, dir);
        spawned++;
      } catch (err) {
        return {
          ok: false,
          error: `spawned ${spawned} of ${count} before failure: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }
    return { ok: true, spawned };
  };
}

export interface StopDaemonsRequest {
  workflow?: string;
  force?: boolean;
}

/**
 * Stop daemons. With `workflow`, stops all daemons for that workflow.
 * Without, attempts to stop every alive daemon across every workflow.
 */
export function buildDaemonsStopHandler(dir: string) {
  return async (
    req: StopDaemonsRequest,
  ): Promise<{ ok: true; stopped: number } | { ok: false; error: string }> => {
    const force = req.force === true;
    if (req.workflow) {
      const stopped = await stopDaemons(req.workflow, force, dir);
      return { ok: true, stopped };
    }
    // No workflow scoped — discover every workflow with alive daemons.
    const d = daemonsDir(dir);
    if (!existsSync(d)) return { ok: true, stopped: 0 };
    const names = new Set<string>();
    for (const file of readdirSync(d)) {
      const m = /^([^-]+(?:-[^-]+)*)-([a-f0-9]+)\.lock\.json$/.exec(file);
      if (m) names.add(m[1]);
    }
    let total = 0;
    for (const wf of names) {
      const stopped = await stopDaemons(wf, force, dir);
      total += stopped;
    }
    return { ok: true, stopped: total };
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
