import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";

const mocks = vi.hoisted(() => ({
  delegateCalls: [] as unknown[],
  watchCalls: [] as unknown[],
}));

vi.mock("../../../../../src/core/delegate.js", () => ({
  delegateToAllImpl: vi.fn(async (opts: {
    inputs: unknown[];
    deriveItemId: (input: unknown) => string;
  }) => {
    mocks.delegateCalls.push(opts);
    return opts.inputs.map((input, index) => ({
      itemId: opts.deriveItemId(input),
      runId: `child-run-${index + 1}`,
    }));
  }),
}));

vi.mock("../../../../../src/tracker/delegation/watch-child-runs.js", () => ({
  watchChildRuns: vi.fn(async (opts: {
    workflow: string;
    expectedItemIds: string[];
    onProgress?: (outcome: {
      workflow: string;
      itemId: string;
      runId: string;
      status: "done" | "failed";
      data?: Record<string, string>;
      terminalEntry?: { data?: Record<string, string> };
    }, remaining: number) => void;
  }) => {
    mocks.watchCalls.push(opts);
    const itemId = opts.expectedItemIds[0] ?? "";
    const outcome: {
      workflow: string;
      itemId: string;
      runId: string;
      status: "done" | "failed";
      data?: Record<string, string>;
      terminalEntry?: { data?: Record<string, string> };
    } =
      opts.workflow === "i9-lookup"
        ? {
            workflow: "i9-lookup",
            itemId,
            runId: "i9-run-2222",
            status: "done" as const,
            data: { signerName: "Smith, John", i9Status: "signed" },
            terminalEntry: { data: { __traceId: "vf-101010-i922" } },
          }
        : {
            workflow: "person-lookup",
            itemId,
            runId: "pl-run-1111",
            status: "done" as const,
            data: {
              emplId: "10000001",
              activeStatus: "active",
              employmentDate: "2026-04-01",
              oathDate: "2026-04-23",
              searchName: "Doe, Jane",
            },
            terminalEntry: { data: { __traceId: "vf-101010-pl11" } },
          };
    opts.onProgress?.(outcome, 0);
    return [outcome];
  }),
}));

describe("verifyOcrFormSpec.enrichRecords progress", () => {
  it("emits record updates as person and i9 child lookups finish", async () => {
    vi.resetModules();
    const { verifyOcrFormSpec } = await import(
      "../../../../../src/services/ocr/forms/verify.js"
    );
    const snapshots: Array<Array<Record<string, unknown>>> = [];

    const records: any[] = [
      {
        formKind: "oath",
        sourcePage: 1,
        printedName: "Doe, Jane",
        employeeId: "",
        paperEmploymentDate: null,
        paperDateSigned: null,
        employeeSigned: true,
        officerSigned: false,
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
    ];

    await verifyOcrFormSpec.enrichRecords?.({
      records,
      runId: "ocr-run-1",
      sessionId: "session-1",
      trackerDir: "unused",
      date: "2026-06-08",
      parentSubject: undefined,
      rootTracePrefix: "vf-101010",
      runOptions: undefined,
      emitProgress: (next) => {
        snapshots.push(JSON.parse(JSON.stringify(next)));
      },
    });

    const afterPerson = snapshots.find(
      (snapshot) => snapshot[0]?.personLookupStatus === "completed" && !snapshot[0]?.officialSigner,
    );
    assert.ok(afterPerson, "person lookup completion should emit before i9 finishes");
    assert.equal(afterPerson[0]?.personLookupTraceId, "vf-101010-pl11");
    assert.equal(afterPerson[0]?.activeStatus, "active");

    const i9Pending = snapshots.find(
      (snapshot) => snapshot[0]?.i9LookupStatus === "pending" && !snapshot[0]?.officialSigner,
    );
    assert.ok(i9Pending, "i9 dispatch should emit a pending state for this record");

    const afterI9 = snapshots.find(
      (snapshot) => snapshot[0]?.i9LookupStatus === "completed" && snapshot[0]?.officialSigner === "Smith, John",
    );
    assert.ok(afterI9, "i9 completion should emit as soon as the child finishes");
    assert.equal(afterI9[0]?.i9LookupTraceId, "vf-101010-i922");
  });

  it("counts an i9 child that completed-but-errored (i9Status=error) as FAILED, not completed (A5)", async () => {
    vi.resetModules();
    vi.doMock("../../../../../src/tracker/delegation/watch-child-runs.js", () => ({
      watchChildRuns: vi.fn(async (opts: {
        workflow: string;
        expectedItemIds: string[];
        onProgress?: (outcome: {
          workflow: string;
          itemId: string;
          runId: string;
          status: "done" | "failed";
          data?: Record<string, string>;
          terminalEntry?: { data?: Record<string, string> };
        }, remaining: number) => void;
      }) => {
        const itemId = opts.expectedItemIds[0] ?? "";
        // The i9 child RUN succeeds (status "done") but its DATA reports an error.
        const outcome: {
          workflow: string;
          itemId: string;
          runId: string;
          status: "done" | "failed";
          data: Record<string, string>;
          terminalEntry: { data: Record<string, string> };
        } =
          opts.workflow === "i9-lookup"
            ? { workflow: "i9-lookup", itemId, runId: "i9-err", status: "done", data: { i9Status: "error" }, terminalEntry: { data: { __traceId: "vf-101010-i9er" } } }
            : { workflow: "person-lookup", itemId, runId: "pl-ok", status: "done", data: { emplId: "10000001", activeStatus: "active" }, terminalEntry: { data: { __traceId: "vf-101010-plok" } } };
        opts.onProgress?.(outcome, 0);
        return [outcome];
      }),
    }));
    const { verifyOcrFormSpec } = await import(
      "../../../../../src/services/ocr/forms/verify.js"
    );

    const records: any[] = [
      {
        formKind: "oath", sourcePage: 1, printedName: "Doe, Jane", employeeId: "",
        employeeSigned: true, officerSigned: false, documentType: "expected",
        originallyMissing: [], notes: [], name: "Doe, Jane", matchState: "extracted",
        selected: true, warnings: [], checks: [],
      },
    ];
    await verifyOcrFormSpec.enrichRecords?.({
      records,
      runId: "ocr-run-err",
      sessionId: "session-err",
      trackerDir: "unused",
      date: "2026-06-11",
      parentSubject: undefined,
      rootTracePrefix: "vf-101010",
      runOptions: undefined,
      emitProgress: () => {},
    });

    assert.equal(records[0]?.i9LookupStatus, "failed", "i9Status=error → i9LookupStatus failed, not completed");
    vi.doUnmock("../../../../../src/tracker/delegation/watch-child-runs.js");
  });
});
