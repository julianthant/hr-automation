/**
 * Shared private helpers used by two or more handler-bucket files in this
 * folder. Not part of the public surface — not re-exported from index.ts.
 */
import { appendFileSync, mkdirSync } from "fs";
import { appendLogEntry, dateLocal, readEntries, readEntriesForDate, trackEvent } from "../../jsonl.js";
import { emitItemCancelled } from "../../session-events.js";
import {
  daemonsDir,
} from "../../../core/daemon/registry.js";
import { queueFilePath } from "../../../core/daemon/queue.js";
import type { QueueEvent } from "../../../core/daemon/types.js";
import { openControlDb } from "../../../core/control-db.js";
import { createTaskStore, type ControlTaskStore, type TaskRow } from "../../../core/task-store/index.js";
import { createWorkerStore, type ControlWorkerStore } from "../../../core/daemon/worker-store.js";

export const DASHBOARD_CANCEL_ERROR = "cancelled by user from dashboard";

export function openControlStores(dir: string): {
  taskStore: ControlTaskStore;
  workerStore: ControlWorkerStore;
} {
  const control = openControlDb({ trackerDir: dir });
  return {
    taskStore: createTaskStore(control),
    workerStore: createWorkerStore(control),
  };
}

export function resolveControlTask(
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

export function appendQueueAudit(workflow: string, event: QueueEvent, dir: string): void {
  mkdirSync(daemonsDir(dir), { recursive: true });
  appendFileSync(queueFilePath(workflow, dir), JSON.stringify(event) + "\n");
}

export function appendQueueFailedAudit(
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

export function appendQueueEnqueueAudit(
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

/**
 * Resolve the workflowInstance for a given (workflow, runId) so dashboard
 * cancel handlers — which only have (workflow, id, runId) — can still emit
 * a `SessionEvent` (which requires `workflowInstance`). Scans today's
 * tracker entries first, then yesterday's as a near-midnight fallback.
 * Returns null when no entry carries `data.instance` for that run; callers
 * skip the event emit silently in that case (the tracker row written
 * alongside is the authoritative user-visible signal).
 */
function resolveInstanceForRunId(workflow: string, runId: string, dir: string): string | null {
  for (const e of readEntries(workflow, dir)) {
    if (e.runId === runId && typeof e.data?.instance === "string") {
      return e.data.instance;
    }
  }
  const ydate = dateLocal(new Date(Date.now() - 24 * 60 * 60 * 1000));
  for (const e of readEntriesForDate(workflow, ydate, dir)) {
    if (e.runId === runId && typeof e.data?.instance === "string") {
      return e.data.instance;
    }
  }
  return null;
}

export function emitDashboardCancelTrackerRow(
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
  // Surface the cancellation primarily as a session event (Events tab)
  // instead of a warn-level log line (arrow-icon All tab). Falls back to
  // the legacy log line when the workflowInstance can't be resolved
  // (e.g., the run never emitted a tracker row carrying `data.instance`,
  // which happens in tests and any pre-instance-stamping legacy data).
  let emittedEvent = false;
  if (runId) {
    const instance = resolveInstanceForRunId(workflow, runId, dir);
    if (instance) {
      emitItemCancelled(instance, id, DASHBOARD_CANCEL_ERROR, dir, runId);
      emittedEvent = true;
    }
  }
  if (!emittedEvent) {
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
}

export function emitDashboardCancelRequestedLog(
  workflow: string,
  id: string,
  runId: string,
  dir: string,
): void {
  // Cooperative cancel — daemon will pick the cancel up at the next step
  // boundary. Surface the "requested, waiting" state as a session event
  // when we can resolve workflowInstance, otherwise fall back to a warn
  // log entry so the operator still sees something even when no tracker
  // row has stamped data.instance yet.
  const reason = "Cancellation requested by dashboard; waiting for the worker to stop this run.";
  const instance = resolveInstanceForRunId(workflow, runId, dir);
  if (instance) {
    emitItemCancelled(instance, id, reason, dir, runId);
    return;
  }
  appendLogEntry(
    {
      workflow,
      itemId: id,
      runId,
      level: "warn",
      message: reason,
      ts: new Date().toISOString(),
    },
    dir,
  );
}

export function currentAttemptWorker(
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
