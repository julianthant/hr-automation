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
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { openControlDb } from "../../../src/core/control-db.js";
import { createTaskStore } from "../../../src/core/task-store/index.js";
import { closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { buildRetryHandler } from "../../../src/control/ops/retry.js";
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
