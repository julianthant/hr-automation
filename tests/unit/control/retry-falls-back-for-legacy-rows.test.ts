/**
 * Contract 2 (Uniform Retry) legacy-row fallback. Tasks enqueued before
 * migration 11 have `tasks.original_input_json = NULL`. The retry path
 * must:
 *   1. Recognise the missing snapshot,
 *   2. Fall back to the legacy JSONL reconstruction path
 *      (`findEntryInput` + `mergeAccumulatedTrackerStrings`),
 *   3. Log a one-time `[retry] falling back...` warning per process so
 *      operators see the regression in their logs.
 *
 * After this contract migrates fully and the warning hasn't fired in
 * weeks, the deprecated fallback can be deleted.
 */
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { openControlDb } from "../../../src/core/control-db.js";
import { createTaskStore } from "../../../src/core/task-store/index.js";
import { closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { trackEvent } from "../../../src/tracker/jsonl.js";
import { buildRetryHandler, __resetLegacyRetryFallbackWarningForTests } from "../../../src/control/ops/retry.js";
import { log } from "../../../src/utils/log.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "retry-legacy-"));
  __resetLegacyRetryFallbackWarningForTests();
});
afterEach(() => {
  closeStateDbForTests(tmp);
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("retry falls back to JSONL reconstruction for legacy rows (Contract 2)", () => {
  it("retries successfully and emits a one-time warn when original_input_json is null", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);

    // Enqueue normally — original_input_json gets stamped.
    const [enqueued] = taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "9999", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["legacy-run"],
    });

    // Simulate the pre-migration-11 row: NULL the snapshot to mimic a row
    // that pre-dates the contract.
    taskStore.db
      .prepare("UPDATE tasks SET original_input_json = NULL WHERE id = ?")
      .run(enqueued.taskId);

    // Tracker rows from the failed run — used by the legacy reconstruction path.
    trackEvent(
      {
        workflow: "work-study",
        timestamp: "2026-05-23T12:00:00.000Z",
        id: "9999",
        runId: "legacy-run",
        status: "pending",
        data: { archetype: "single", emplId: "9999", effectiveDate: "2026-05-01" },
        input: { emplId: "9999", effectiveDate: "2026-05-01" },
      },
      tmp,
    );
    trackEvent(
      {
        workflow: "work-study",
        timestamp: "2026-05-23T12:01:00.000Z",
        id: "9999",
        runId: "legacy-run",
        status: "failed",
        step: "transaction:failed",
        data: { archetype: "single", emplId: "9999", effectiveDate: "2026-05-01" },
        error: "boom",
      },
      tmp,
    );

    taskStore.claimNextTask({ workflow: "work-study", workerId: "w1" });
    taskStore.markTaskFailed({
      taskId: enqueued.taskId,
      attemptId: enqueued.attemptId,
      error: "boom",
    });

    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    const result = await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: "9999",
      runId: "legacy-run",
    });
    assert.equal(result.ok, true);

    // The legacy-fallback warning fires exactly once.
    const fallbackWarnings = warnSpy.mock.calls.filter((args) =>
      typeof args[0] === "string" && args[0].includes("falling back to JSONL reconstruction for legacy row"),
    );
    assert.equal(fallbackWarnings.length, 1, "expected exactly one legacy-fallback warn");

    // A second retry on the same legacy task should NOT log a second warning
    // (per-process latch). Re-fail then retry again.
    taskStore.markTaskFailed({
      taskId: enqueued.taskId,
      attemptId: taskStore.getTask(enqueued.taskId)!.currentAttemptId!,
      error: "boom2",
    });
    // Re-NULL because retryTaskFromAttempt would have reset input_json from
    // (still NULL) original_input_json — so this row stays legacy.
    taskStore.db
      .prepare("UPDATE tasks SET original_input_json = NULL WHERE id = ?")
      .run(enqueued.taskId);
    await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: "9999",
      runId: taskStore.getTask(enqueued.taskId)!.currentRunId!,
    });
    const fallbackWarningsAfter = warnSpy.mock.calls.filter((args) =>
      typeof args[0] === "string" && args[0].includes("falling back to JSONL reconstruction for legacy row"),
    );
    assert.equal(fallbackWarningsAfter.length, 1, "warning is per-process; second retry must not re-warn");
  });
});
