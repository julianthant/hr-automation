/**
 * Retry state guard (Bug #2 from Contract 1-5 post-review fixes).
 *
 * `cancel.ts` rejects cancel-queued requests against rows in active states
 * (`claimed | running | cancel_requested | cancelling`). Retry was missing
 * the same guard, so retrying a running task would reset the row to
 * `queued` while the daemon kept running the old attempt — producing two
 * concurrent attempts.
 *
 * These tests exercise the SQLite-backed retry branch in
 * `src/control/ops/retry.ts:reEnqueueEntry` and assert the structured
 * error fires before `retryTaskFromAttempt` mutates state.
 */
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { openControlDb } from "../../../src/core/control-db.js";
import { createTaskStore } from "../../../src/core/task-store/index.js";
import { closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { buildRetryHandler, buildRetryBulkHandler } from "../../../src/control/ops/retry.js";
import * as emitInherited from "../../../src/control/ops/emit-inherited.js";
import { emitTrackerRow } from "../../../src/tracker/jsonl-io.js";
import {
  resetDaemonSpawnStubs,
  stubDaemonSpawn,
} from "../../_utils/stub-daemon-spawn.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "retry-state-guard-"));
});
afterEach(async () => {
  await resetDaemonSpawnStubs();
  closeStateDbForTests(tmp);
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe("retry state guard — blocks retry against active attempts", () => {
  it("returns structured error when task is in `claimed` state", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);

    taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "1111", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["active-run-claimed"],
    });

    // Claim the task — sets control_state = 'claimed'.
    taskStore.claimNextTask({ workflow: "work-study", workerId: "w1" });

    const result = await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: "1111",
      runId: "active-run-claimed",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /currently claimed/);
    assert.match(result.error, /cancel the active attempt before retrying/);
    assert.match(result.error, /active-run-claimed/);
  });

  it("returns structured error when task is in `running` state", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);

    taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "2222", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["active-run-running"],
    });

    // Claim + transition to 'running' (mirrors what the daemon does after claim).
    const claimed = taskStore.claimNextTask({ workflow: "work-study", workerId: "w1" });
    assert.ok(claimed);
    control.db.prepare(`UPDATE tasks SET control_state = 'running' WHERE id = @taskId`).run({ taskId: claimed.taskId });

    const result = await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: "2222",
      runId: "active-run-running",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /currently running/);
  });

  it("returns structured error when task is in `cancel_requested` state", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);

    taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "3333", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["active-run-cancel-req"],
    });

    const claimed = taskStore.claimNextTask({ workflow: "work-study", workerId: "w1" });
    assert.ok(claimed);
    control.db.prepare(`UPDATE tasks SET control_state = 'cancel_requested' WHERE id = @taskId`).run({ taskId: claimed.taskId });

    const result = await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: "3333",
      runId: "active-run-cancel-req",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /currently cancel_requested/);
  });

  it("returns structured error when task is in `cancelling` state", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);

    taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "4444", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["active-run-cancelling"],
    });

    const claimed = taskStore.claimNextTask({ workflow: "work-study", workerId: "w1" });
    assert.ok(claimed);
    control.db.prepare(`UPDATE tasks SET control_state = 'cancelling' WHERE id = @taskId`).run({ taskId: claimed.taskId });

    const result = await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: "4444",
      runId: "active-run-cancelling",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /currently cancelling/);
  });

  it("allows retry against a `failed` task (terminal — guard does not fire)", async () => {
    stubDaemonSpawn(tmp, { instanceId: "retry-state-guard" });
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);

    const [enqueued] = taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "5555", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["failed-run"],
    });

    taskStore.claimNextTask({ workflow: "work-study", workerId: "w1" });
    taskStore.markTaskFailed({
      taskId: enqueued.taskId,
      attemptId: enqueued.attemptId,
      error: "transient failure",
    });

    emitTrackerRow(
      {
        workflow: "work-study",
        timestamp: new Date().toISOString(),
        id: "5555",
        runId: "failed-run",
        status: "failed",
        data: { archetype: "single", emplId: "5555" },
      },
      tmp,
    );

    const result = await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: "5555",
      runId: "failed-run",
    });

    // The guard does not block terminal `failed`. The retry should proceed.
    assert.equal(result.ok, true);
  });
});

describe("retry TOCTOU race — daemon claims the task between the state pre-check and the retry UPDATE", () => {
  it("refuses the retry with a legible error and leaves the daemon's claim intact", async () => {
    // The pre-check (ACTIVE_STATES_BLOCKING_RETRY) reads control_state, then
    // the handler does JSONL I/O (findInheritedPriorEntry) before calling
    // retryTaskFromAttempt. A daemon claim landing inside that window used to
    // slip past the pre-check and get reset to queued while the worker kept
    // running the old attempt (double execution). Simulate the race by
    // claiming the task from inside a spied findInheritedPriorEntry — i.e.
    // exactly between the pre-check and the retry UPDATE.
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);

    taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "6666", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["raced-run"],
    });
    emitTrackerRow(
      {
        workflow: "work-study",
        timestamp: new Date().toISOString(),
        id: "6666",
        runId: "raced-run",
        status: "pending",
        data: { archetype: "single", emplId: "6666" },
      },
      tmp,
    );

    const realFind = emitInherited.findInheritedPriorEntry;
    const spy = vi
      .spyOn(emitInherited, "findInheritedPriorEntry")
      .mockImplementation((args) => {
        // The mid-window daemon claim: queued -> claimed. The pre-check has
        // already passed (the task was queued when it ran).
        const claimed = taskStore.claimNextTask({ workflow: "work-study", workerId: "daemon-raced" });
        assert.ok(claimed, "the simulated daemon claim must succeed");
        return realFind(args);
      });

    try {
      const result = await buildRetryHandler(tmp)({
        workflow: "work-study",
        id: "6666",
        runId: "raced-run",
      });

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /became claimed while retrying/);
      assert.match(result.error, /raced-run/);

      // The daemon's claim must survive: still claimed, still owned by the
      // racing worker, exactly one attempt (the retry's INSERT rolled back).
      const task = taskStore.findTaskByIdentity({ workflow: "work-study", itemId: "6666" });
      assert.ok(task);
      assert.equal(task.state, "claimed");
      assert.equal(task.claimedByWorkerId, "daemon-raced");
      assert.equal(taskStore.listAttemptsForTask(task.taskId).length, 1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("bulk retry — per-item safety on the same guarded path", () => {
  it("captures the active-state refusal per item and still retries the terminal sibling", async () => {
    stubDaemonSpawn(tmp, { instanceId: "retry-bulk-guard" });
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);

    // Item A: claimed (active) -> must be refused.
    taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "7777", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["bulk-active-run"],
    });
    taskStore.claimNextTask({ workflow: "work-study", workerId: "w1" });

    // Item B: failed (terminal) -> retry proceeds.
    const [taskB] = taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "8888", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["bulk-failed-run"],
    });
    taskStore.claimNextTask({ workflow: "work-study", workerId: "w1" });
    taskStore.markTaskFailed({ taskId: taskB.taskId, attemptId: taskB.attemptId, error: "boom" });

    for (const [id, runId, status] of [
      ["7777", "bulk-active-run", "running"],
      ["8888", "bulk-failed-run", "failed"],
    ] as const) {
      emitTrackerRow(
        {
          workflow: "work-study",
          timestamp: new Date().toISOString(),
          id,
          runId,
          status,
          data: { archetype: "single", emplId: id },
        },
        tmp,
      );
    }

    const result = await buildRetryBulkHandler(tmp)({
      workflow: "work-study",
      items: [
        { id: "7777", runId: "bulk-active-run" },
        { id: "8888", runId: "bulk-failed-run" },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.count, 1, "only the terminal item retries");
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].id, "7777");
    assert.match(result.errors[0].error, /currently claimed/);

    // The active item's claim is untouched.
    const taskA = taskStore.findTaskByIdentity({ workflow: "work-study", itemId: "7777" });
    assert.equal(taskA?.state, "claimed");
  });
});
