import { existsSync, readFileSync, writeFileSync } from "fs";
import { mkdir, rmdir } from "fs/promises";
import { setTimeout as delay } from "timers/promises";
import { cancelInProcessRun } from "../../../core/daemon/in-process-runs.js";
import { queueFilePath, queueLockDirPath } from "../../../core/daemon/queue.js";
import type { QueueEvent } from "../../../core/daemon/types.js";
import type { BrowserProcessRow, ControlWorkerStore } from "../../../core/daemon/worker-store.js";
import {
  DASHBOARD_CANCEL_ERROR,
  openControlStores,
  resolveControlTask,
  appendQueueFailedAudit,
  emitDashboardCancelTrackerRow,
  emitDashboardCancelRequestedLog,
  currentAttemptWorker,
} from "./shared.js";

export interface CancelQueuedRequest {
  workflow: string;
  id: string;
  runId?: string;
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

export interface ForceStopTaskRequest {
  workflow: string;
  id: string;
  runId?: string;
}

export interface KillBrowserRequest {
  browserProcessId?: string;
  pid?: number;
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
          throw new Error("queue lock acquisition timed out", { cause: err });
        }
        await delay(100);
        continue;
      }
      throw err;
    }
  }
  throw new Error("queue lock acquisition exhausted");
}

function signalBrowserPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* best-effort hard-control fallback */
  }
}

async function requestDaemonForceCurrent(
  worker: import("../../../core/daemon/worker-store.js").WorkerRow | null,
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

export function enqueueKillBrowserCommand(workerStore: ControlWorkerStore, browser: BrowserProcessRow): string {
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
        const { log } = await import("../../../utils/log.js");
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
