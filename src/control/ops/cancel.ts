/**
 * Low-level cancel operations (queued / running / bulk).
 *
 * These are the primitives behind the central action engine — operator
 * cancels arrive through `actions/perform-workflow-action.ts`, which decides
 * scope and routes here. The handlers stay independently exported so daemon
 * code and tests can call a single primitive directly.
 *
 * Contract 5 (2026-05-23) removed the soft/force distinction: there is one
 * cancel mechanism now. The kernel's per-run AbortController + Page proxy
 * (see `src/core/kernel/page-proxy.ts`) makes cancel propagate into in-
 * flight Playwright work within ms, so the legacy `force-stop` HTTP route
 * + about:blank navigation + page-interrupt machinery are gone.
 *
 * Phase 1 (2026-05-26): in-process cancels route through `runRegistry.cancel`
 * — the same unified entry point the daemon's worker-command path eventually
 * reaches. Pre-Phase-1, in-process cancel called `killChromeHard` directly
 * (no AbortController abort), so a stuck-on-Duo `sharepoint-download` took
 * seconds to surface a generic "Browser closed" failure row. Phase 1
 * aborts the controller first; the watchdog inside `runRegistry.cancel`
 * falls back to `killChromeHard` only when nothing observes the signal.
 */
import { runRegistry } from "../../core/run-registry.js";
import { wakeDaemonsForReleasedParents } from "../../core/daemon/client.js";
import type { BrowserProcessRow, ControlWorkerStore } from "../../core/daemon/worker-store.js";
import {
  DASHBOARD_CANCEL_ERROR,
  openControlStores,
  resolveControlTask,
  appendQueueFailedAudit,
  emitDashboardCancelTrackerRow,
  emitDashboardCancelRequestedLog,
  currentAttemptWorker,
} from "./shared.js";
import { findInheritedPriorEntry } from "./emit-inherited.js";

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
  | { ok: true; accepted: true; mode: "stale-tracker" }
  | { ok: false; error: string; status?: number };

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
      const auditRunId = req.runId ?? task.currentRunId ?? task.runId;
      const priorEntry = findInheritedPriorEntry({
        workflow: req.workflow,
        trackerDir: dir,
        id: req.id,
        ...(auditRunId ? { runId: auditRunId } : {}),
        db: stores.taskStore.db,
      });
      if (!priorEntry) {
        return {
          ok: false as const,
          error: `cannot cancel: prior tracker row is missing for workflow=${req.workflow} id=${req.id}` +
            (auditRunId ? ` runId=${auditRunId}` : ""),
          status: 404,
        };
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
      const released = stores.taskStore.markDependencyFromChildTerminal({
        childTaskId: task.taskId,
        childState: "cancelled",
      });
      // Wake the released parents' daemons now — without it a parent whose
      // last pending dependency this cancel just settled sits queued until
      // that daemon's 15-min keepalive tick (E2E-017).
      void wakeDaemonsForReleasedParents(released, dir);
      appendQueueFailedAudit(req.workflow, req.id, auditRunId, DASHBOARD_CANCEL_ERROR, dir);
      // SQLite fast-path hint: bulk cancel goes O(K*D*L) on the prior-row
      // lookup without it (Finding #13). Single-row callers still benefit.
      emitDashboardCancelTrackerRow(req.workflow, req.id, auditRunId, dir, stores.taskStore.db);
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

    // Phase 1: in-process cancel routes through `runRegistry.cancel`,
    // which aborts the per-run AbortController (so any in-flight
    // Playwright call rejects within ms via the Page proxy) and schedules
    // a watchdog `killChromeHard` fallback for the rare case where
    // nothing observes the signal (pre-handler launch hang, e.g. stuck on
    // Duo). Awaited so the HTTP response reflects whether the watchdog
    // fired — but the watchdog itself is best-effort; failures don't
    // propagate.
    const inProcess = await runRegistry.cancel(req.runId, {
      reason: "dashboard_in_process",
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

    const latest = findInheritedPriorEntry({
      workflow: req.workflow,
      trackerDir: dir,
      id: req.id,
      runId: req.runId,
      db: stores.taskStore.db,
    });
    if (latest?.status === "running") {
      appendQueueFailedAudit(req.workflow, req.id, req.runId, DASHBOARD_CANCEL_ERROR, dir);
      emitDashboardCancelTrackerRow(req.workflow, req.id, req.runId, dir, stores.taskStore.db);
      return { ok: true, accepted: true, mode: "stale-tracker" };
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
 *
 * HTTP routes no longer call this directly — `/api/cancel-active-bulk` wraps
 * `performWorkflowAction`. Exported for unit tests and as a low-level helper.
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
