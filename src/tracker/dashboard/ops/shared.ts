/**
 * Shared private helpers used by two or more handler-bucket files in this
 * folder. Not part of the public surface — not re-exported from index.ts.
 */
import { appendFileSync, mkdirSync } from "fs";
import { appendLogEntry, trackEvent } from "../../jsonl.js";
import {
  daemonsDir,
} from "../../../core/daemon-registry.js";
import { queueFilePath } from "../../../core/daemon-queue.js";
import type { QueueEvent } from "../../../core/daemon-types.js";
import { openControlDb } from "../../../core/control-db.js";
import { createTaskStore, type ControlTaskStore, type TaskRow } from "../../../core/task-store.js";
import { createWorkerStore, type ControlWorkerStore } from "../../../core/worker-store.js";

export const DASHBOARD_CANCEL_ERROR = "cancelled by user from dashboard";

export function openControlStores(dir: string): {
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

export function emitDashboardCancelRequestedLog(
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
