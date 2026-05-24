/**
 * Finding #15 — Daemon-dispatch path of delegateToAll (`dispatchToDaemonAndWait`).
 *
 * The existing `ctx-delegate-to.test.ts` exercises the in-process path only:
 * every child workflow in those tests is NOT registered in `WORKFLOW_LOADERS`,
 * so `isDaemonCapable` returns false and `runInProcessPool` is used.
 *
 * This file covers `dispatchToDaemonAndWait` — the ~100-line code path that
 * fires when the child IS daemon-capable. It verifies:
 *
 *   A. `ensureDaemonsAndEnqueue` is called with the expected inputs.
 *   B. The `onPreEmitPending` hook fires per item, writing a pending JSONL row
 *      with `archetype: "delegate-child"` (Contract 1 stamping).
 *   C. `watchChildRuns` is called to await terminal statuses.
 *   D. Returned `ChildRunResult[]` are in INPUT ORDER even when `watchChildRuns`
 *      resolves outcomes in a DIFFERENT (reverse) order.
 *   E. fire-and-forget: `watchChildRuns` is NOT called; returned results carry
 *      the daemon-assigned runIds and `status: "pending"`.
 *
 * ESM binding note: `delegate.ts` imports `listWorkflowNames` as a live ESM
 * binding. `vi.mock` replaces the module's exported property, but since
 * `delegate.ts` captures the binding at module-load time, the mock only takes
 * effect if `delegate.ts` is loaded AFTER the mock registry is established.
 *
 * The fix: call `vi.resetModules()` before the mocks, then use dynamic imports
 * in the tests themselves so every module (including `delegate.ts`) is freshly
 * resolved against the mock registry. See `tests/CLAUDE.md`: "Dynamic-import
 * cache busting uses `vi.resetModules()`".
 */
import { describe, test, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Reset module registry so that vi.mock intercepts are applied BEFORE delegate.ts
// resolves its import of `listWorkflowNames`. Without this, delegate.ts captures
// the real binding at first load; with vi.resetModules() + dynamic imports below,
// every module is freshly instantiated against the mock registry.
// ---------------------------------------------------------------------------
vi.resetModules();

vi.mock("../../../src/core/workflow-loaders.js", () => ({
  // listWorkflowNames is called by isDaemonCapable; include our sentinel name
  // so routing goes to dispatchToDaemonAndWait instead of runInProcessPool.
  listWorkflowNames: vi.fn(() => ["daemon-test-child"]),
  loadWorkflow: vi.fn().mockResolvedValue(null),
  WORKFLOW_LOADERS: {},
}));

vi.mock("../../../src/core/daemon/client.js", () => ({
  ensureDaemonsAndEnqueue: vi.fn(),
}));

vi.mock("../../../src/tracker/delegation/watch-child-runs.js", () => ({
  watchChildRuns: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TrackerLine {
  workflow: string;
  id: string;
  runId?: string;
  parentRunId?: string;
  status: string;
  data?: Record<string, unknown>;
  input?: unknown;
}

function readWorkflowLines(trackerDir: string, workflow: string, dateStr: string): TrackerLine[] {
  const file = join(trackerDir, `${workflow}-${dateStr}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrackerLine);
}

/**
 * Build a mock implementation of `ensureDaemonsAndEnqueue` that:
 *   - calls `onPreEmitPending` for each input (synchronously), supplying
 *     the caller-provided `itemId` / `runId` pairs so `dispatchToDaemonAndWait`
 *     can populate its `expectedItemIds` / `expectedRunIds` arrays.
 *   - returns `{ ok: true, enqueued: inputs.length }`.
 *
 * The `items` array tells the mock which itemId/runId to assign per input,
 * in input order.
 */
function buildEnqueueMock(
  items: Array<{ itemId: string; runId: string }>,
): (...args: unknown[]) => Promise<unknown> {
  return vi.fn(async (_wf, inputs, _flags, opts) => {
    const { onPreEmitPending } = opts as {
      onPreEmitPending?: (
        input: unknown,
        runId: string,
        parentRunId: string | undefined,
        itemId: string,
      ) => void;
    };
    if (onPreEmitPending) {
      for (let i = 0; i < (inputs as unknown[]).length; i++) {
        const { itemId, runId } = items[i];
        onPreEmitPending((inputs as unknown[])[i], runId, undefined, itemId);
      }
    }
    return { ok: true, enqueued: (inputs as unknown[]).length };
  });
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let trackerDir: string;
let dateStr: string;

beforeEach(async () => {
  trackerDir = mkdtempSync(join(tmpdir(), "daemon-delegate-"));
  // Capture today's date string in the same format as dateLocal() (local YYYY-MM-DD).
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
});

afterEach(() => {
  if (trackerDir && existsSync(trackerDir)) rmSync(trackerDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests — all use dynamic imports so they see the freshly-mocked modules.
// ---------------------------------------------------------------------------

describe("dispatchToDaemonAndWait — daemon-dispatch path of delegateToAll (Finding #15)", () => {
  test("calls ensureDaemonsAndEnqueue and watchChildRuns; returns results in INPUT order", async () => {
    // Dynamic imports get the freshly-mocked module instances.
    const { defineWorkflow } = await import("../../../src/core/index.js");
    const { delegateToAllImpl } = await import("../../../src/core/delegate.js");
    const clientMod = await import("../../../src/core/daemon/client.js");
    const watchMod = await import("../../../src/tracker/delegation/watch-child-runs.js");

    const ensureDaemonsAndEnqueue = clientMod.ensureDaemonsAndEnqueue as ReturnType<typeof vi.fn>;
    const watchChildRuns = watchMod.watchChildRuns as ReturnType<typeof vi.fn>;

    const child = defineWorkflow({
      name: "daemon-test-child",
      archetype: "single",
      systems: [],
      authSteps: false,
      steps: ["work"] as const,
      schema: z.object({ payload: z.string() }),
      detailFields: [{ key: "payload", label: "Payload" }],
      getName: (d) => d.payload ?? "",
      getId: (d) => d.payload ?? "",
      handler: async () => {},
    });

    // The daemon assigns these runIds in input order.
    const items = [
      { itemId: "item-A", runId: "run-A" },
      { itemId: "item-B", runId: "run-B" },
      { itemId: "item-C", runId: "run-C" },
    ];
    ensureDaemonsAndEnqueue.mockImplementation(buildEnqueueMock(items));

    // watchChildRuns returns outcomes in REVERSE order (completion order).
    // dispatchToDaemonAndWait must re-sort to input order.
    watchChildRuns.mockResolvedValue([
      { workflow: "daemon-test-child", itemId: "item-C", runId: "run-C", status: "done", data: { payload: "C" } },
      { workflow: "daemon-test-child", itemId: "item-A", runId: "run-A", status: "done", data: { payload: "A" } },
      { workflow: "daemon-test-child", itemId: "item-B", runId: "run-B", status: "failed", error: "b failed" },
    ]);

    const results = await delegateToAllImpl({
      parentRunId: "parent-run-x",
      trackerDir,
      child,
      inputs: [{ payload: "A" }, { payload: "B" }, { payload: "C" }],
      fireAndForget: false,
    });

    // A. ensureDaemonsAndEnqueue was called once with all 3 inputs.
    assert.equal(ensureDaemonsAndEnqueue.mock.calls.length, 1, "ensureDaemonsAndEnqueue called once");
    const [, enqueuedInputs] = ensureDaemonsAndEnqueue.mock.calls[0] as [unknown, unknown[]];
    assert.equal(enqueuedInputs.length, 3, "all 3 inputs passed to ensureDaemonsAndEnqueue");

    // B. watchChildRuns was called to await terminal statuses.
    assert.equal(watchChildRuns.mock.calls.length, 1, "watchChildRuns called once");

    // C. Results are returned in INPUT order (A, B, C) despite outcomes
    //    arriving in reverse order (C, A, B) from watchChildRuns.
    assert.equal(results.length, 3);
    assert.equal(results[0].itemId, "item-A", "first result is item-A (input order preserved)");
    assert.equal(results[0].runId, "run-A");
    assert.equal(results[0].status, "done");

    assert.equal(results[1].itemId, "item-B", "second result is item-B (input order preserved)");
    assert.equal(results[1].runId, "run-B");
    assert.equal(results[1].status, "failed");
    assert.equal(results[1].error?.message, "b failed");

    assert.equal(results[2].itemId, "item-C", "third result is item-C (input order preserved)");
    assert.equal(results[2].runId, "run-C");
    assert.equal(results[2].status, "done");

    // D. Pending JSONL rows were pre-emitted for each child (onPreEmitPending
    //    hook — Contract 1 archetype stamping on the daemon path).
    const lines = readWorkflowLines(trackerDir, "daemon-test-child", dateStr);
    const pending = lines.filter((l) => l.status === "pending");
    assert.equal(pending.length, 3, "one pending row emitted per child via onPreEmitPending (Contract 1)");

    for (const { itemId, runId } of items) {
      const row = pending.find((l) => l.id === itemId);
      assert.ok(row, `pending row for ${itemId} must exist`);
      assert.equal(row!.runId, runId, `pending row for ${itemId} carries assigned runId`);
      assert.equal(
        (row!.data as { archetype?: string }).archetype,
        "delegate-child",
        `pending row for ${itemId} carries archetype=delegate-child`,
      );
    }
  });

  test("fire-and-forget: ensureDaemonsAndEnqueue is called but watchChildRuns is NOT; results carry daemon runIds", async () => {
    const { defineWorkflow } = await import("../../../src/core/index.js");
    const { delegateToAllImpl } = await import("../../../src/core/delegate.js");
    const clientMod = await import("../../../src/core/daemon/client.js");
    const watchMod = await import("../../../src/tracker/delegation/watch-child-runs.js");

    const ensureDaemonsAndEnqueue = clientMod.ensureDaemonsAndEnqueue as ReturnType<typeof vi.fn>;
    const watchChildRuns = watchMod.watchChildRuns as ReturnType<typeof vi.fn>;

    const child = defineWorkflow({
      name: "daemon-test-child",
      archetype: "single",
      systems: [],
      authSteps: false,
      steps: ["work"] as const,
      schema: z.object({ payload: z.string() }),
      detailFields: [{ key: "payload", label: "Payload" }],
      getName: (d) => d.payload ?? "",
      getId: (d) => d.payload ?? "",
      handler: async () => {},
    });

    const items = [
      { itemId: "faf-A", runId: "faf-run-A" },
      { itemId: "faf-B", runId: "faf-run-B" },
    ];
    ensureDaemonsAndEnqueue.mockImplementation(buildEnqueueMock(items));

    const results = await delegateToAllImpl({
      parentRunId: "parent-faf",
      trackerDir,
      child,
      inputs: [{ payload: "X" }, { payload: "Y" }],
      fireAndForget: true,
    });

    // ensureDaemonsAndEnqueue called once.
    assert.equal(ensureDaemonsAndEnqueue.mock.calls.length, 1, "ensureDaemonsAndEnqueue called");

    // watchChildRuns must NOT be called (fire-and-forget returns immediately).
    assert.equal(watchChildRuns.mock.calls.length, 0, "watchChildRuns must NOT be called for fireAndForget");

    // Results carry daemon-assigned runIds (not empty strings) and status: "pending".
    // This verifies the Bug #4 fix applies to the daemon path too.
    assert.equal(results.length, 2);
    assert.equal(results[0].status, "pending", "fireAndForget returns pending immediately");
    assert.equal(results[0].runId, "faf-run-A", "fire-and-forget result carries daemon-assigned runId (not '')");
    assert.notEqual(results[0].runId, "", "runId must not be empty string");
    assert.equal(results[1].status, "pending");
    assert.equal(results[1].runId, "faf-run-B");
    assert.notEqual(results[1].runId, "");
  });

  test("input-order preservation: missing outcome synthesized as failed using expected runId (not empty string)", async () => {
    const { defineWorkflow } = await import("../../../src/core/index.js");
    const { delegateToAllImpl } = await import("../../../src/core/delegate.js");
    const clientMod = await import("../../../src/core/daemon/client.js");
    const watchMod = await import("../../../src/tracker/delegation/watch-child-runs.js");

    const ensureDaemonsAndEnqueue = clientMod.ensureDaemonsAndEnqueue as ReturnType<typeof vi.fn>;
    const watchChildRuns = watchMod.watchChildRuns as ReturnType<typeof vi.fn>;

    const child = defineWorkflow({
      name: "daemon-test-child",
      archetype: "single",
      systems: [],
      authSteps: false,
      steps: ["work"] as const,
      schema: z.object({ payload: z.string() }),
      detailFields: [{ key: "payload", label: "Payload" }],
      getName: (d) => d.payload ?? "",
      getId: (d) => d.payload ?? "",
      handler: async () => {},
    });

    const items = [
      { itemId: "miss-A", runId: "miss-run-A" },
      { itemId: "miss-B", runId: "miss-run-B" },
    ];
    ensureDaemonsAndEnqueue.mockImplementation(buildEnqueueMock(items));

    // watchChildRuns only resolves ONE outcome (miss-B). miss-A never terminates.
    // The kernel must synthesize a failed result for miss-A using the known runId
    // (Bug #4 fix: no longer falls back to "" as runId).
    watchChildRuns.mockResolvedValue([
      { workflow: "daemon-test-child", itemId: "miss-B", runId: "miss-run-B", status: "done" },
    ]);

    const results = await delegateToAllImpl({
      parentRunId: "parent-miss",
      trackerDir,
      child,
      inputs: [{ payload: "A" }, { payload: "B" }],
      fireAndForget: false,
    });

    assert.equal(results.length, 2);

    // miss-A had no outcome → synthesized as failed, but MUST carry the known runId.
    assert.equal(results[0].itemId, "miss-A", "first result is miss-A (input order)");
    assert.equal(
      results[0].runId,
      "miss-run-A",
      "no-outcome result carries expected runId (not '' — Bug #4 fix on daemon path)",
    );
    assert.notEqual(results[0].runId, "", "runId must not be empty string");
    assert.equal(results[0].status, "failed", "no-outcome result synthesized as failed");

    // miss-B completed normally.
    assert.equal(results[1].itemId, "miss-B", "second result is miss-B (input order)");
    assert.equal(results[1].runId, "miss-run-B");
    assert.equal(results[1].status, "done");
  });
});
