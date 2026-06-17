import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";

/**
 * ISS-003 pin: watchChildRuns timeout in enrichRecords must NOT hard-fail the
 * whole OCR verify run. Instead:
 *   - Records whose lookups DID finish should be stamped with their outcomes.
 *   - Records whose lookups never settled (missingItemIds) should be marked
 *     `personLookupStatus: "failed"` (or `i9LookupStatus: "failed"`) with a
 *     "timed out" note — the same treatment the existing per-record timeout
 *     handling already uses.
 *   - `enrichRecords` resolves (does NOT throw) so the OCR run reaches
 *     `done`/`awaiting-review` with a partial completeness report rather than
 *     hard-failing and losing all enriched data.
 *
 * The summary log must mention partial completion ("timed out").
 *
 * Before the fix, a timeout from `fanOutAndWatch` propagated through
 * `Promise.allSettled` → `firstRejection` throw → the whole `enrichRecords`
 * call rejected with a bare "watchChildRuns timeout (1800000ms) — still
 * waiting for: <itemIds>" string and the operator saw a hard-failed OCR run
 * with no completeness data.
 */

// ─── Mock: delegate (required but not under test here) ──────────────────────

vi.mock("../../../../../src/core/delegate.js", () => ({
  delegateToAllImpl: vi.fn(
    async (opts: { inputs: unknown[]; deriveItemId: (i: unknown) => string }) =>
      opts.inputs.map((input, index) => ({
        itemId: opts.deriveItemId(input),
        runId: `child-run-${index + 1}`,
      })),
  ),
}));

// ─── Mock: no abort flag (not an operator cancel — purely a timeout) ─────────

vi.mock("../../../../../src/tracker/ocr-prepare-abort.js", () => ({
  isOcrPrepareAbortRequested: vi.fn(() => false),
  isOperatorDiscardAbortError: (err: unknown) =>
    err instanceof Error && err.name === "OcrPrepareOperatorDiscardAbort",
}));

vi.mock("../../../../../src/tracker/tasks/store.js", () => ({
  openTaskStore: vi.fn(() => ({ db: {} })),
  cancelQueuedChildTasksForParentRun: vi.fn(() => 0),
}));

// ─── Mock: watchChildRuns throws a timeout (one child per call) ──────────────
//
// Simulates a scenario with 2 oath records:
//   - person-lookup: record 0 settles (done), record 1 times out
//   - i9-lookup: record 0 (no officerSigned) settles (done)
//
// The person-lookup call throws after calling onProgress for itemId[0] only.
// The i9-lookup call resolves normally (record 0 has no officerSigned).

vi.mock("../../../../../src/tracker/delegation/watch-child-runs.js", () => ({
  watchChildRuns: vi.fn(
    async (opts: {
      workflow: string;
      expectedItemIds: string[];
      onProgress?: (
        outcome: {
          workflow: string;
          itemId: string;
          runId: string;
          status: "done" | "failed";
          data?: Record<string, string>;
          terminalEntry?: { data?: Record<string, string> };
        },
        remaining: number,
      ) => void;
    }) => {
      if (opts.workflow === "person-lookup") {
        // First record completes OK via onProgress.
        const firstItemId = opts.expectedItemIds[0] ?? "";
        opts.onProgress?.(
          {
            workflow: "person-lookup",
            itemId: firstItemId,
            runId: "pl-run-settled",
            status: "done",
            data: {
              emplId: "10000001",
              activeStatus: "active",
              employmentDate: "2026-04-01",
              oathDate: "2026-04-23",
              searchName: "Doe, Jane",
            },
            terminalEntry: { data: { __traceId: "vf-101010-plok" } },
          },
          opts.expectedItemIds.length - 1,
        );
        // Then the second record never settles → timeout.
        const timeoutMs = 500; // tiny timeout for the test
        throw new Error(
          `watchChildRuns timeout (${timeoutMs}ms) — still waiting for: ${opts.expectedItemIds[1] ?? ""}`,
        );
      }
      // i9-lookup: single record, resolves normally.
      const itemId = opts.expectedItemIds[0] ?? "";
      const outcome = {
        workflow: "i9-lookup",
        itemId,
        runId: "i9-run-ok",
        status: "done" as const,
        data: { signerName: "Smith, John", i9Status: "signed" },
        terminalEntry: { data: { __traceId: "vf-101010-i9ok" } },
      };
      opts.onProgress?.(outcome, 0);
      return [outcome];
    },
  ),
}));

describe("verifyOcrFormSpec.enrichRecords timeout handling (ISS-003)", () => {
  it("resolves with a partial report when person-lookup times out (not a hard-fail)", async () => {
    vi.resetModules();
    const { verifyOcrFormSpec } = await import(
      "../../../../../src/services/ocr/forms/verify.js"
    );

    // Two oath records: record 0 will get its person-lookup settled; record 1
    // will time out mid-watch.
    const records: any[] = [
      {
        formKind: "oath",
        sourcePage: 1,
        printedName: "Doe, Jane",
        employeeId: "",
        paperEmploymentDate: null,
        paperDateSigned: null,
        employeeSigned: true,
        officerSigned: false, // triggers i9-lookup for record 0
        paperOfficialName: null,
        documentType: "expected",
        originallyMissing: [],
        notes: [],
        name: "Doe, Jane",
        matchState: "extracted",
        selected: true,
        warnings: [],
        checks: [],
      },
      {
        formKind: "oath",
        sourcePage: 2,
        printedName: "Smith, Bob",
        employeeId: "",
        paperEmploymentDate: null,
        paperDateSigned: null,
        employeeSigned: true,
        officerSigned: true, // already signed — no i9-lookup
        paperOfficialName: null,
        documentType: "expected",
        originallyMissing: [],
        notes: [],
        name: "Smith, Bob",
        matchState: "extracted",
        selected: true,
        warnings: [],
        checks: [],
      },
    ];

    // Must NOT throw — partial result is acceptable, hard-fail is not.
    let threw: unknown;
    let result: any[] | undefined;
    try {
      result = await verifyOcrFormSpec.enrichRecords?.({
        records,
        runId: "ocr-run-timeout",
        sessionId: "session-timeout",
        trackerDir: "unused",
        date: "2026-06-17",
        parentSubject: undefined,
        rootTracePrefix: "vf-101010",
        runOptions: undefined,
        emitProgress: () => {},
      });
    } catch (err) {
      threw = err;
    }

    assert.strictEqual(
      threw,
      undefined,
      `enrichRecords must NOT throw on a watchChildRuns timeout — instead it should surface a partial report. Got: ${String(threw)}`,
    );

    // Record 0: person-lookup settled → should be "completed" (or at minimum not "failed").
    assert.equal(
      records[0]?.personLookupStatus,
      "completed",
      "record 0 person-lookup settled before the timeout — must be marked completed",
    );
    assert.equal(
      records[0]?.activeStatus,
      "active",
      "record 0 must carry its enriched activeStatus",
    );

    // Record 1: person-lookup timed out → must be marked "failed" (timed-out), not left undefined.
    assert.equal(
      records[1]?.personLookupStatus,
      "failed",
      "record 1 person-lookup timed out — must be marked failed (timed-out), not left pending/undefined",
    );

    // i9-lookup for record 0: settled normally.
    assert.equal(
      records[0]?.i9LookupStatus,
      "completed",
      "record 0 i9-lookup settled — must be marked completed",
    );
    assert.equal(
      records[0]?.officialSigner,
      "Smith, John",
      "record 0 must carry the enriched officialSigner from i9-lookup",
    );
  });
});
