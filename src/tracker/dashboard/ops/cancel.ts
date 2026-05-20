/**
 * Low-level cancel operations (queued / running / force-stop / bulk).
 *
 * These are the primitives behind the central action engine — operator
 * cancels arrive through `actions/perform-workflow-action.ts`, which decides
 * scope and routes here. The handlers stay independently exported so daemon
 * code and tests can call a single primitive directly.
 */
import { cancelInProcessRun } from "../../../core/daemon/in-process-runs.js";
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

export interface CancelActiveBulkItem {
  id: string;
  status: "pending" | "running";
  runId?: string;
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
  // Manual AbortController + clearTimeout (not AbortSignal.timeout) so the
  // timer can't fire after the response completes — see "abort race" lesson.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await fetch(`http://127.0.0.1:${worker.port}/force-current`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId, runId }),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
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

/** Cancel a queued SQLite task — mirrored to JSONL audit + tracker. */
export function buildCancelQueuedHandler(dir: string) {
  return async (
    req: CancelQueuedRequest,
  ): Promise<{ ok: true } | { ok: false; error: string; status?: number }> => {
    if (!req.workflow || !req.id) return { ok: false, error: "workflow and id are required" };
    const stores = openControlStores(dir);
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
    return {
      ok: false as const,
      error: "task not found in SQLite control store",
      status: 404,
    };
  };
}

export function buildCancelRunningHandler(dir: string) {
  return async (req: CancelRunningRequest): Promise<CancelRunningResult> => {
    if (!req.workflow || !req.id || !req.runId) {
      return { ok: false, error: "workflow, id, runId are required", status: 400 };
    }
    const stores = openControlStores(dir);
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

/**
 * Cancel many in-flight queue rows: **running** first (cooperative daemon cancel),
 * then **pending** (queued SQLite). Matches per-row `/api/cancel-running`
 * and `/api/cancel-queued` behavior.
 */
export function buildCancelActiveBulkHandler(dir: string) {
  const cancelQueued = buildCancelQueuedHandler(dir);
  const cancelRunning = buildCancelRunningHandler(dir);
  return async (req: {
    workflow: string;
    items: CancelActiveBulkItem[];
  }): Promise<{
    ok: true;
    count: number;
    errors: Array<{ id: string; error: string }>;
  }> => {
    const errors: Array<{ id: string; error: string }> = [];
    let count = 0;
    const workflow = req.workflow;
    const running = req.items.filter((i) => i.status === "running");
    const pending = req.items.filter((i) => i.status === "pending");

    for (const item of running) {
      if (!item.runId) {
        errors.push({
          id: item.id,
          error:
            "runId is required for running items — the dashboard must send each row's tracker run id (UUID or legacy id#N)",
        });
        continue;
      }
      const r = await cancelRunning({ workflow, id: item.id, runId: item.runId });
      if (r.ok) count++;
      else errors.push({ id: item.id, error: r.error });
    }
    for (const item of pending) {
      const r = await cancelQueued({
        workflow,
        id: item.id,
        ...(item.runId ? { runId: item.runId } : {}),
      });
      if (r.ok) count++;
      else errors.push({ id: item.id, error: r.error });
    }
    return { ok: true as const, count, errors };
  };
}

export function buildForceStopTaskHandler(dir: string) {
  return async (
    req: ForceStopTaskRequest,
  ): Promise<{ ok: true; commandId: string } | { ok: false; error: string; status?: number }> => {
    if (!req.workflow || !req.id) return { ok: false, error: "workflow and id are required", status: 400 };
    const stores = openControlStores(dir);
    const task = resolveControlTask(stores.taskStore, req.workflow, req.id, req.runId);
    if (!task) return { ok: false, error: "task not found", status: 404 };
    const { workerId, attemptId } = currentAttemptWorker(stores.taskStore, stores.workerStore, task);
    const worker = workerId ? stores.workerStore.getWorker(workerId) : null;
    const runId = req.runId ?? task.currentRunId ?? task.runId;
    // Chrome-preserving force-cancel:
    // - Mark the SQLite task cancelled so the daemon's claim-loop
    //   precedence check sees it and writes a cancelled tracker row even
    //   if the in-flight step happens to finish at the same instant.
    // - Enqueue a `cancel_task` worker command (not `force_stop_task`) so
    //   the daemon's command handler sets the cooperative-cancel flag
    //   without triggering shutdown.
    // - Call the daemon's /force-current HTTP endpoint, which now
    //   navigates each system's page to about:blank to interrupt
    //   in-flight Playwright work — chrome and the daemon stay alive,
    //   just the current item dies. The Stepper's catch block converts
    //   the resulting Playwright error to CancelledError.
    // - DO NOT enqueue kill_browser commands or SIGTERM browser PIDs;
    //   the operator explicitly does not want chrome torn down on a
    //   per-item cancel.
    const commandId = stores.workerStore.enqueueWorkerCommand({
      commandType: "cancel_task",
      workflow: req.workflow,
      ...(workerId ? { targetWorkerId: workerId } : {}),
      targetTaskId: task.taskId,
      ...(attemptId ? { targetAttemptId: attemptId } : {}),
      payload: { itemId: req.id, runId, source: "dashboard-force-stop" },
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
    if (!daemonAccepted) {
      const { log } = await import("../../../utils/log.js");
      log.warn(
        `[force-stop] task ${req.workflow}/${req.id} could not reach daemon /force-current — marked cancelled in control state; daemon will pick up the worker_command on next poll`,
      );
    }
    return { ok: true, commandId };
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
  };
}
