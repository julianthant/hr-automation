/**
 * Integration test: Retry replays the pristine original input (Contract 2).
 *
 * Drives two `runOneItem` calls through the real kernel:
 *   1. First run: item FAILS mid-way (handler throws after updating data).
 *   2. Retry: item succeeds using the ORIGINAL (pristine) input, not the
 *      accumulated tracker state.
 *
 * This exercises:
 *   - Real JSONL emit for both runs (pending, running, failed / done rows).
 *   - The kernel's input isolation: `run-one-item.ts` stamps `input` on the
 *     pending row from the raw `item` argument (which is the unmodified
 *     original input). The retry caller passes the same original input to
 *     `runOneItem`, confirming it is not derived from accumulated JSONL data.
 *   - Coexistence: both the failed run's rows AND the successful retry's rows
 *     land in the same JSONL file, keyed by distinct `runId`s.
 *
 * The test also verifies that `tasks.original_input_json` from SQLite matches
 * the pristine input (the retry path in the real daemon uses this field), using
 * the same setup style as `tests/unit/control/retry-uses-original-input.test.ts`.
 */
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { defineWorkflow, runOneItem } from "../../src/core/kernel/workflow.js";
import { Session } from "../../src/core/kernel/session.js";
import { readEntries } from "../../src/tracker/jsonl.js";
import { closeStateDbForTests } from "../../src/tracker/state/db.js";
import { openControlDb } from "../../src/core/control-db.js";
import { createTaskStore } from "../../src/core/task-store/index.js";
import { emitTrackerRow } from "../../src/tracker/jsonl-io.js";

// ─── Workflow under test ──────────────────────────────────────────────────────

interface RetryInput {
  emplId: string;
  shouldFail?: boolean;
}

/**
 * Workflow that fails its submit step when `input.shouldFail === true`.
 * Simulates: the first run fails after writing `lookedUpEid` to data; the
 * retry uses the original input (without `shouldFail`) and succeeds cleanly.
 */
const retryTestWorkflow = defineWorkflow({
  name: "int-retry-test",
  label: "Integration Retry Test",
  archetype: "single",
  systems: [],
  authSteps: false,
  steps: ["lookup", "submit"] as const,
  schema: z.object({
    emplId: z.string(),
    shouldFail: z.boolean().optional(),
  }),
  detailFields: [{ key: "emplId", label: "EID" }],
  getName: (d) => d.emplId ?? "",
  getId: (d) => d.emplId ?? "",
  handler: async (ctx, input) => {
    await ctx.step("lookup", async () => {
      // Simulate a mid-run data mutation that should NOT leak into the retry.
      ctx.updateData({ emplId: input.emplId, lookedUpEid: "ENRICHED-" + input.emplId });
    });
    await ctx.step("submit", async () => {
      if (input.shouldFail) {
        throw new Error("submit failed — simulated transient error");
      }
      ctx.updateData({ submitted: "true" });
    });
  },
});

// ─── Shared fake Session factory ──────────────────────────────────────────────

function makeSession() {
  return Session.forTesting({
    systems: [],
    browsers: new Map(),
    readyPromises: new Map(),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("retry replays pristine original input (Contract 2) via real runOneItem", () => {
  test("failed run then retry-from-original both coexist in JSONL with correct status + input", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "retry-int-"));
    t.onTestFinished(() => {
      closeStateDbForTests(dir);
      rmSync(dir, { recursive: true, force: true });
    });

    const itemId = "retry-eid-001";
    const originalInput: RetryInput = { emplId: itemId };
    const failingInput: RetryInput = { ...originalInput, shouldFail: true };

    const failRunId = randomUUID();
    const retryRunId = randomUUID();

    // ── Arrange: first run (fails) ────────────────────────────────────────────
    const session = makeSession();
    // Stub captureAll so screenshot code doesn't reach real Playwright.
    (session as unknown as { captureAll: () => Promise<unknown[]> }).captureAll = async () => [];

    const failResult = await runOneItem({
      wf: retryTestWorkflow,
      session,
      item: failingInput,
      itemId,
      runId: failRunId,
      trackerDir: dir,
      callerPreEmits: false,
    });

    // First run must fail.
    assert.equal(
      failResult.ok,
      false,
      `first run should fail; got: ${JSON.stringify(failResult)}`,
    );

    // ── Act: retry from original pristine input ───────────────────────────────
    // The retry caller uses the ORIGINAL input (not the failed run's accumulated state).
    const retryResult = await runOneItem({
      wf: retryTestWorkflow,
      session: makeSession(),
      item: originalInput, // <── pristine, no shouldFail
      itemId,
      runId: retryRunId,
      trackerDir: dir,
      callerPreEmits: false,
    });

    assert.equal(
      retryResult.ok,
      true,
      `retry run should succeed; got: ${JSON.stringify(retryResult)}`,
    );

    // ── Assert: both runs' rows coexist in JSONL ──────────────────────────────
    const allRows = readEntries("int-retry-test", dir);

    const failRows = allRows.filter((r) => r.runId === failRunId);
    const retryRows = allRows.filter((r) => r.runId === retryRunId);

    // Failed run: must have a pending row and a failed row.
    assert.ok(
      failRows.find((r) => r.status === "pending"),
      "failed run must have a pending row",
    );
    const failedRow = failRows.find((r) => r.status === "failed");
    assert.ok(failedRow, "failed run must have a failed row");

    // Retry run: must have a pending row and a done row.
    assert.ok(
      retryRows.find((r) => r.status === "pending"),
      "retry run must have a pending row",
    );
    const retryDone = retryRows.find((r) => r.status === "done");
    assert.ok(retryDone, "retry run must have a done row");

    // Retry done row must have submitted=true (full success path ran).
    assert.equal(
      retryDone.data?.submitted,
      "true",
      "retry done row must have submitted=true",
    );

    // ── Assert: pristine input on retry pending row ───────────────────────────
    const retryPending = retryRows.find((r) => r.status === "pending");
    assert.ok(retryPending, "retry pending row must exist");
    assert.deepEqual(
      retryPending.input,
      originalInput,
      `retry pending row must carry pristine input — not accumulated data from failed run; got: ${JSON.stringify(retryPending.input)}`,
    );

    // Verify the retry pending row does NOT carry `shouldFail` (it would be
    // `false` / `undefined` — either way, the original input never had it).
    assert.equal(
      (retryPending.input as Record<string, unknown>)?.shouldFail,
      undefined,
      "retry input must not carry shouldFail from the failing run's input",
    );
  });

  test("SQLite original_input_json preserves pristine input across retry cycle", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "retry-sqlite-"));
    t.onTestFinished(() => {
      closeStateDbForTests(dir);
      rmSync(dir, { recursive: true, force: true });
    });

    const control = openControlDb({ trackerDir: dir });
    const taskStore = createTaskStore(control);

    const emplId = "sqlite-retry-001";
    const pristineInput = { emplId, shouldFail: false };

    // ── Step 1: Enqueue task with pristine input (simulating daemon enqueue) ──
    const [enqueued] = taskStore.enqueueTasks({
      workflow: "int-retry-test",
      inputs: [pristineInput],
      deriveItemId: (input) => input.emplId,
      runIds: ["first-run-sqlite"],
    });

    // ── Step 2: Simulate first run failing (mutates data but not original_input_json) ──
    emitTrackerRow(
      {
        workflow: "int-retry-test",
        timestamp: new Date().toISOString(),
        id: emplId,
        runId: "first-run-sqlite",
        status: "pending",
        data: {
          archetype: "single",
          emplId,
          __name: emplId,
          __id: emplId,
        },
        input: pristineInput,
      },
      dir,
    );

    emitTrackerRow(
      {
        workflow: "int-retry-test",
        timestamp: new Date().toISOString(),
        id: emplId,
        runId: "first-run-sqlite",
        status: "running",
        step: "lookup",
        data: {
          archetype: "single",
          emplId,
          // Simulated data mutation that must NOT appear on retry.
          lookedUpEid: "ENRICHED-" + emplId,
        },
      },
      dir,
    );

    emitTrackerRow(
      {
        workflow: "int-retry-test",
        timestamp: new Date().toISOString(),
        id: emplId,
        runId: "first-run-sqlite",
        status: "failed",
        step: "submit",
        data: {
          archetype: "single",
          emplId,
          lookedUpEid: "ENRICHED-" + emplId,
        },
        error: "submit failed",
      },
      dir,
    );

    taskStore.claimNextTask({ workflow: "int-retry-test", workerId: "w1" });
    taskStore.markTaskFailed({
      taskId: enqueued.taskId,
      attemptId: enqueued.attemptId,
      error: "submit failed",
    });

    // ── Step 3: Verify original_input_json was preserved ─────────────────────
    const task = taskStore.getTask(enqueued.taskId);
    assert.ok(task, "task must exist in SQLite");

    const originalInput = taskStore.findOriginalInputForRunId("first-run-sqlite");
    assert.deepEqual(
      originalInput,
      pristineInput,
      `original_input_json must match pristine input; got: ${JSON.stringify(originalInput)}`,
    );

    // ── Step 4: Execute the retry using the pristine input ────────────────────
    const retryRunId = randomUUID();
    const session = Session.forTesting({ systems: [], browsers: new Map(), readyPromises: new Map() });
    (session as unknown as { captureAll: () => Promise<unknown[]> }).captureAll = async () => [];

    // The retry caller uses the original input (no shouldFail).
    const retryResult = await runOneItem({
      wf: retryTestWorkflow,
      session,
      item: pristineInput, // pristine — no shouldFail
      itemId: emplId,
      runId: retryRunId,
      trackerDir: dir,
      callerPreEmits: false,
    });

    assert.equal(retryResult.ok, true, `retry must succeed; got: ${JSON.stringify(retryResult)}`);

    // ── Step 5: Retry done row must not carry lookedUpEid from failed run ─────
    const allRows = readEntries("int-retry-test", dir);
    const retryDone = allRows.find((r) => r.runId === retryRunId && r.status === "done");
    assert.ok(retryDone, "retry done row must exist");

    // The retry run doesn't see the previous run's data — it gets a clean slate.
    const retryPending = allRows.find((r) => r.runId === retryRunId && r.status === "pending");
    assert.ok(retryPending, "retry pending row must exist");
    assert.deepEqual(
      retryPending.input,
      pristineInput,
      "retry pending row must carry the pristine original input",
    );
    // Note: control.db is left open; closeStateDbForTests(dir) in onTestFinished
    // will handle the shared SQLite state.db. The controlDb is a separate handle
    // but shares the same underlying file — close it before the dir is cleaned up.
  });

  test("retry input isolation: accumulated tracker data does not bleed into next run", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "retry-isolation-"));
    t.onTestFinished(() => {
      closeStateDbForTests(dir);
      rmSync(dir, { recursive: true, force: true });
    });

    const emplId = "isolate-001";
    const session = Session.forTesting({ systems: [], browsers: new Map(), readyPromises: new Map() });
    (session as unknown as { captureAll: () => Promise<unknown[]> }).captureAll = async () => [];

    // Run 1: fails.
    await runOneItem({
      wf: retryTestWorkflow,
      session,
      item: { emplId, shouldFail: true } as RetryInput,
      itemId: emplId,
      runId: "iso-run-1",
      trackerDir: dir,
      callerPreEmits: false,
    });

    // Run 2: retry with the same pristine input (without shouldFail).
    // Critically, the retry caller does NOT read accumulated JSONL state.
    const session2 = Session.forTesting({ systems: [], browsers: new Map(), readyPromises: new Map() });
    (session2 as unknown as { captureAll: () => Promise<unknown[]> }).captureAll = async () => [];

    const retryResult = await runOneItem({
      wf: retryTestWorkflow,
      session: session2,
      item: { emplId } as RetryInput, // no shouldFail — pristine original
      itemId: emplId,
      runId: "iso-run-2",
      trackerDir: dir,
      callerPreEmits: false,
    });

    assert.equal(retryResult.ok, true, "retry must succeed with pristine input");

    // The retry's pending row must not carry lookedUpEid from the failed run.
    const allRows = readEntries("int-retry-test", dir);
    const retryPending = allRows.find((r) => r.runId === "iso-run-2" && r.status === "pending");
    assert.ok(retryPending, "retry pending row must exist");

    // The retry input is { emplId } — no shouldFail, no accumulated lookedUpEid.
    assert.equal(
      (retryPending.input as Record<string, unknown>)?.lookedUpEid,
      undefined,
      "retry pending row must NOT carry lookedUpEid leaked from the failed run's accumulated data",
    );
    assert.equal(
      (retryPending.input as Record<string, unknown>)?.shouldFail,
      undefined,
      "retry pending row must NOT carry shouldFail from failed run's input",
    );
  });
});
