/**
 * Contract 2 (Uniform Retry) — kernel-level guarantee that a retry replays
 * the workflow against the PRISTINE original input the prior run saw at
 * step 0, NOT the accumulated state baked into later tracker rows.
 *
 * Before Contract 2, `reEnqueueEntry` reconstructed the retry input via
 * `findEntryInput` + `mergeAccumulatedTrackerStrings`, which folded every
 * `data.*` field across the JSONL history (latest non-empty value wins).
 * That meant retrying a "find EID then submit" workflow handed the new
 * run `{ emplId, lookedUpEid: ... }` instead of just `{ emplId }`, and
 * step-zero gating checks silently no-op'd because the field was already
 * "set."
 *
 * These tests exercise the SQLite-backed retry branch in
 * `src/control/ops/retry.ts:reEnqueueEntry`. The pre-emitted pending
 * tracker row is the source of truth for "what input will the new run
 * actually see" — the daemon's claim path (`parseJson(input_json)`) hands
 * the handler exactly that.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { openControlDb } from "../../../src/core/control-db.js";
import { createTaskStore } from "../../../src/core/task-store/index.js";
import { closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { trackEvent, readEntries } from "../../../src/tracker/jsonl.js";
import { buildRetryHandler } from "../../../src/control/ops/retry.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "retry-original-"));
});
afterEach(() => {
  closeStateDbForTests(tmp);
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe("retry uses pristine original input (Contract 2)", () => {
  it("re-enqueues with the original input even when later tracker rows carry mutated data", async () => {
    const control = openControlDb({ trackerDir: tmp });
    const taskStore = createTaskStore(control);

    // 1. First enqueue — pristine input is { emplId: "1234" }.
    const [enqueued] = taskStore.enqueueTasks({
      workflow: "work-study",
      inputs: [{ emplId: "1234", effectiveDate: "2026-05-01" }],
      deriveItemId: (input) => input.emplId,
      runIds: ["original-run"],
    });

    // 2. Claim + run mutated the task: the handler looked up the EID and a
    // later step wrote it back as data.lookedUpEid. Simulate by appending a
    // running and a failed tracker row that both carry the mutated field.
    trackEvent(
      {
        workflow: "work-study",
        timestamp: "2026-05-23T12:00:00.000Z",
        id: "1234",
        runId: "original-run",
        status: "pending",
        data: {
          archetype: "single",
          emplId: "1234",
          effectiveDate: "2026-05-01",
          __name: "Some Person",
          __id: "1234",
          __subject: "Some Person",
          __queueTitle: "Some Person — work-study",
        },
        input: { emplId: "1234", effectiveDate: "2026-05-01" },
      },
      tmp,
    );
    trackEvent(
      {
        workflow: "work-study",
        timestamp: "2026-05-23T12:00:30.000Z",
        id: "1234",
        runId: "original-run",
        status: "running",
        step: "transaction",
        data: {
          archetype: "single",
          emplId: "1234",
          lookedUpEid: "00000099",
          effectiveDate: "2026-05-01",
          __name: "Some Person",
          __id: "1234",
          __subject: "Some Person",
          __queueTitle: "Some Person — work-study",
        },
      },
      tmp,
    );
    trackEvent(
      {
        workflow: "work-study",
        timestamp: "2026-05-23T12:01:00.000Z",
        id: "1234",
        runId: "original-run",
        status: "failed",
        step: "transaction:failed",
        data: {
          archetype: "single",
          emplId: "1234",
          lookedUpEid: "00000099",
          name: "Some Person",
          effectiveDate: "2026-05-01",
          __name: "Some Person",
          __id: "1234",
          __subject: "Some Person",
          __queueTitle: "Some Person — work-study",
        },
        error: "submit timeout",
      },
      tmp,
    );

    // Also mark the SQLite attempt failed so retryTaskFromAttempt unwinds cleanly.
    taskStore.claimNextTask({ workflow: "work-study", workerId: "w1" });
    taskStore.markTaskFailed({
      taskId: enqueued.taskId,
      attemptId: enqueued.attemptId,
      error: "submit timeout",
    });

    // 3. Retry through the public handler.
    const result = await buildRetryHandler(tmp)({
      workflow: "work-study",
      id: "1234",
      runId: "original-run",
    });
    assert.equal(result.ok, true);

    // 4. The new attempt's pending tracker row should carry the PRISTINE
    // input — NOT the mutated lookedUpEid / name. Find it by looking for
    // the most recent pending row.
    const pendingRows = readEntries("work-study", tmp).filter((e) => e.status === "pending");
    const newPending = pendingRows[pendingRows.length - 1];
    assert.ok(newPending, "expected a new pending row after retry");
    assert.notEqual(newPending.runId, "original-run", "retry must use a fresh runId");
    assert.deepEqual(
      newPending.input,
      { emplId: "1234", effectiveDate: "2026-05-01" },
      "retry pending row carries pristine input — no leaked lookedUpEid / name",
    );

    // 5. Provenance stamp — the new pending row references the prior runId
    // so the dashboard can show "retried from <prior-run>".
    assert.equal(newPending.data?.__retriedFrom, "original-run");

    // 5a. Display metadata is preserved — without this the retry's pending
    // row shows up nameless in the dashboard until the daemon claims it
    // and rewrites. Carry __name / __id / __subject / __queueTitle forward
    // from the prior row's data field (Contract 1 stamping happens later
    // when the handler runs ctx.updateData).
    assert.equal(newPending.data?.__name, "Some Person", "preserve __name on retry pending row");
    assert.equal(newPending.data?.__id, "1234", "preserve __id on retry pending row");
    assert.equal(newPending.data?.__subject, "Some Person", "preserve __subject on retry pending row");
    assert.equal(
      newPending.data?.__queueTitle,
      "Some Person — work-study",
      "preserve __queueTitle on retry pending row",
    );

    // 6. The SQLite task's input_json was ALSO reset to the original input
    // so the daemon's claim path hands the handler the same payload.
    const reread = taskStore.getTask(enqueued.taskId);
    assert.deepEqual(reread?.input, { emplId: "1234", effectiveDate: "2026-05-01" });

    // 7. Original input snapshot is preserved across the retry.
    const originalAfterRetry = taskStore.findOriginalInputForRunId(newPending.runId!);
    assert.deepEqual(originalAfterRetry, { emplId: "1234", effectiveDate: "2026-05-01" });
  });
});
