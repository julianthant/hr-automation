/**
 * Unit tests for src/control/ops/supersede.ts
 *
 * Proves the "one active run per queue row" guard on the enqueue path: a fresh
 * input run cancels any prior non-terminal ROOT run for the same item, while
 * leaving other items, delegated members, and the new run itself untouched.
 *
 * Exercised against a real control store + real cancel handlers over a tmp
 * tracker dir (seeded pending tracker rows so the cancel handlers can inherit
 * prior-row metadata), matching the buildCancelQueuedHandler tests in
 * tests/unit/tracker/dashboard-ops.test.ts.
 */
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openControlDb } from "../../../src/core/control-db.js";
import { createTaskStore, type ControlTaskStore } from "../../../src/core/task-store/index.js";
import { createWorkerStore, type ControlWorkerStore } from "../../../src/core/daemon/worker-store.js";
import { emitTrackerRow } from "../../../src/tracker/jsonl-io.js";
import { buildSupersedePriorRunsHandler } from "../../../src/control/ops/supersede.js";
import * as cancelOps from "../../../src/control/ops/cancel.js";

const WORKFLOW = "separations";

let tmp: string;
let taskStore: ControlTaskStore;
let workerStore: ControlWorkerStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "supersede-"));
  const control = openControlDb({ trackerDir: tmp });
  taskStore = createTaskStore(control);
  workerStore = createWorkerStore(control);
});

afterEach(() => {
  taskStore.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Seed a queued root task + its pending tracker row; return the enqueued task. */
function seedQueued(docId: string, runId: string, opts: { parentRunId?: string } = {}) {
  const [enqueued] = taskStore.enqueueTasks({
    workflow: WORKFLOW,
    inputs: [{ docId }],
    deriveItemId: (input) => input.docId,
    runIds: [runId],
    ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
  });
  emitTrackerRow(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: docId,
      runId,
      status: "pending",
      data: {
        archetype: "single",
        docId,
        instance: "Separation 1",
      },
      ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
    },
    tmp,
  );
  return enqueued;
}

describe("buildSupersedePriorRunsHandler", () => {
  it("cancels a prior queued run for the same item when a new run is issued", async () => {
    const prior = seedQueued("3930", "run-1");

    // Simulate run-2 being prepared for the same item (3930).
    const result = await buildSupersedePriorRunsHandler(tmp)({
      workflow: WORKFLOW,
      itemIds: ["3930"],
      exceptRunIds: ["run-2"],
    });

    assert.equal(result.cancelled, 1);
    assert.equal(taskStore.getTask(prior.taskId)?.state, "cancelled");
  });

  it("cancels every prior queued run, leaving only the new one active", async () => {
    const run1 = seedQueued("3930", "run-1");
    const run2 = seedQueued("3930", "run-2");

    // run-3 is about to enqueue: both prior queued runs should be cancelled.
    const result = await buildSupersedePriorRunsHandler(tmp)({
      workflow: WORKFLOW,
      itemIds: ["3930"],
      exceptRunIds: ["run-3"],
    });

    assert.equal(result.cancelled, 2);
    assert.equal(taskStore.getTask(run1.taskId)?.state, "cancelled");
    assert.equal(taskStore.getTask(run2.taskId)?.state, "cancelled");
  });

  it("never cancels the new run itself (exceptRunIds)", async () => {
    const fresh = seedQueued("3930", "run-new");

    const result = await buildSupersedePriorRunsHandler(tmp)({
      workflow: WORKFLOW,
      itemIds: ["3930"],
      exceptRunIds: ["run-new"],
    });

    assert.equal(result.cancelled, 0);
    assert.equal(taskStore.getTask(fresh.taskId)?.state, "queued");
  });

  it("leaves a different item's run untouched", async () => {
    const target = seedQueued("3930", "run-1");
    const other = seedQueued("3999", "run-other");

    const result = await buildSupersedePriorRunsHandler(tmp)({
      workflow: WORKFLOW,
      itemIds: ["3930"],
      exceptRunIds: ["run-2"],
    });

    assert.equal(result.cancelled, 1);
    assert.equal(taskStore.getTask(target.taskId)?.state, "cancelled");
    assert.equal(taskStore.getTask(other.taskId)?.state, "queued");
  });

  it("never supersedes a delegated (parentRunId) member", async () => {
    const delegated = seedQueued("3930", "run-deleg", { parentRunId: "op-1" });

    const result = await buildSupersedePriorRunsHandler(tmp)({
      workflow: WORKFLOW,
      itemIds: ["3930"],
    });

    assert.equal(result.cancelled, 0);
    assert.equal(taskStore.getTask(delegated.taskId)?.state, "queued");
  });

  it("routes an in-flight prior run through cancel-running (cancel requested)", async () => {
    const running = seedQueued("3930", "run-running");
    workerStore.registerWorker({
      workerId: "sep-worker",
      workflow: WORKFLOW,
      kind: "daemon",
      pid: 12345,
      hostname: "test-host",
      phase: "processing",
    });
    const claimed = taskStore.claimNextTask({ workflow: WORKFLOW, workerId: "sep-worker" });
    assert.ok(claimed);
    taskStore.markTaskRunning({
      taskId: running.taskId,
      attemptId: running.attemptId,
      workerId: "sep-worker",
    });

    const result = await buildSupersedePriorRunsHandler(tmp)({
      workflow: WORKFLOW,
      itemIds: ["3930"],
      exceptRunIds: ["run-next"],
    });

    assert.equal(result.cancelled, 1);
    // Running rows are cooperatively cancelled: state flips to cancel_requested
    // and a cancel_task worker command is enqueued for the daemon to honor.
    assert.equal(taskStore.getTask(running.taskId)?.state, "cancel_requested");
    const commands = workerStore.db
      .prepare("SELECT command_type FROM worker_commands")
      .all() as Array<{ command_type: string }>;
    assert.ok(commands.some((c) => c.command_type === "cancel_task"));
  });

  it("is a no-op for an empty item list", async () => {
    const result = await buildSupersedePriorRunsHandler(tmp)({ workflow: WORKFLOW, itemIds: [] });
    assert.equal(result.cancelled, 0);
  });

  it("fails loud when cancelling a prior run throws — never lets the new run enqueue as if the old one is gone", async () => {
    seedQueued("3930", "run-1");

    // Force the underlying cancel call to throw (e.g. an unexpected control-
    // store error), instead of returning a documented `{ ok: false }` result.
    const spy = vi
      .spyOn(cancelOps, "buildCancelQueuedHandler")
      .mockReturnValue(async () => {
        throw new Error("boom");
      });

    try {
      await assert.rejects(
        () =>
          buildSupersedePriorRunsHandler(tmp)({
            workflow: WORKFLOW,
            itemIds: ["3930"],
            exceptRunIds: ["run-2"],
          }),
        /failed to cancel prior separations\/3930.*boom/s,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
