import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";

// Task A2 residual: when an operator cancels a RUNNING verify prep, the
// orchestrator trips the in-process prepare-abort flag; the `enrichRecords`
// `watchChildRuns` calls poll `shouldAbort` and throw a discard-abort error.
// verify.ts must (1) stop watching and (2) cascade-cancel the still-queued
// person-lookup / i9-lookup children so a daemon doesn't run them after the
// operator gave up — then rethrow so the orchestrator unwinds to cancelled.

const mocks = vi.hoisted(() => ({
  cascadeCalls: [] as Array<{ parentRunId: string }>,
  abortRequested: true,
}));

vi.mock("../../../../../src/core/delegate.js", () => ({
  delegateToAllImpl: vi.fn(async (opts: { inputs: unknown[]; deriveItemId: (i: unknown) => string }) =>
    opts.inputs.map((input, index) => ({ itemId: opts.deriveItemId(input), runId: `child-run-${index + 1}` })),
  ),
}));

// The abort flag is "set" — `shouldAbort()` returns true.
vi.mock("../../../../../src/tracker/ocr-prepare-abort.js", () => ({
  isOcrPrepareAbortRequested: vi.fn(() => mocks.abortRequested),
  isOperatorDiscardAbortError: (err: unknown) =>
    err instanceof Error && err.name === "OcrPrepareOperatorDiscardAbort",
}));

// The watch honors shouldAbort: when set, throw the discard-abort error.
vi.mock("../../../../../src/tracker/delegation/watch-child-runs.js", () => ({
  watchChildRuns: vi.fn(async (opts: { shouldAbort?: () => boolean }) => {
    if (opts.shouldAbort?.()) {
      const err = new Error("operator discarded OCR prep");
      err.name = "OcrPrepareOperatorDiscardAbort";
      throw err;
    }
    return [];
  }),
}));

// Capture the cascade-cancel call instead of touching real SQLite.
vi.mock("../../../../../src/tracker/tasks/store.js", () => ({
  openTaskStore: vi.fn(() => ({ db: {} })),
  cancelQueuedChildTasksForParentRun: vi.fn(
    (_store: unknown, input: { parentRunId: string }) => {
      mocks.cascadeCalls.push({ parentRunId: input.parentRunId });
      return 1;
    },
  ),
}));

describe("verifyOcrFormSpec.enrichRecords cancel cascade", () => {
  it("cascade-cancels queued children on a mid-enrichment operator cancel, then rethrows", async () => {
    vi.resetModules();
    mocks.cascadeCalls.length = 0;
    mocks.abortRequested = true;
    const { verifyOcrFormSpec } = await import(
      "../../../../../src/services/ocr/forms/verify.js"
    );

    const records: any[] = [
      {
        formKind: "oath",
        sourcePage: 1,
        printedName: "Doe, Jane",
        employeeId: "",
        employeeSigned: true,
        officerSigned: false,
        documentType: "expected",
        originallyMissing: [],
        notes: [],
        name: "Doe, Jane",
        matchState: "extracted",
        selected: true,
        warnings: [],
        checks: [],
      },
    ];

    let threw: unknown;
    try {
      await verifyOcrFormSpec.enrichRecords?.({
        records,
        runId: "ocr-run-cancel",
        sessionId: "session-cancel",
        trackerDir: "unused",
        date: "2026-06-11",
        parentSubject: undefined,
        rootTracePrefix: "vf-101010",
        runOptions: undefined,
        emitProgress: () => {},
      });
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, "enrichRecords must rethrow the discard-abort error on cancel");
    assert.equal((threw as Error).name, "OcrPrepareOperatorDiscardAbort");
    assert.ok(
      mocks.cascadeCalls.length >= 1,
      "cascade-cancel must run on a mid-enrichment cancel",
    );
    assert.equal(
      mocks.cascadeCalls[0]?.parentRunId,
      "ocr-run-cancel",
      "cascade-cancel targets the prep run's children",
    );
  });
});
