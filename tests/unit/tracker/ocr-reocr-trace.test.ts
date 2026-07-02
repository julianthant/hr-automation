import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Task F-B/F-C/N7: whole-PDF re-OCR re-fans person-lookup. The prior raw
// `ensureDaemonsAndEnqueue` passed NO rootTracePrefix, so re-fanned lookups
// minted fresh standalone `pl-…` prefixes. The migration to `delegateToAllImpl`
// must forward the OCR root's trace PREFIX so the re-fan shares the operation id.

const mocks = vi.hoisted(() => ({
  delegateCalls: [] as Array<{ rootTracePrefix?: string; parentRunId?: string; inputs: unknown[] }>,
}));

vi.mock("../../../src/core/delegate.js", () => ({
  delegateToAllImpl: vi.fn(async (opts: {
    rootTracePrefix?: string;
    parentRunId?: string;
    inputs: unknown[];
    deriveItemId: (i: unknown) => string;
  }) => {
    mocks.delegateCalls.push({
      ...(opts.rootTracePrefix !== undefined ? { rootTracePrefix: opts.rootTracePrefix } : {}),
      ...(opts.parentRunId !== undefined ? { parentRunId: opts.parentRunId } : {}),
      inputs: opts.inputs,
    });
    return opts.inputs.map((input) => ({ itemId: opts.deriveItemId(input), runId: "child-run" }));
  }),
}));

function dateLocalForTest(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("reocr-whole-pdf re-fan trace propagation", () => {
  it("forwards the OCR root trace prefix to the person-lookup re-fan (delegateToAllImpl)", async () => {
    vi.resetModules();
    mocks.delegateCalls.length = 0;
    const { rowFilePath, rowsDir } = await import("../../../src/tracker/paths.js");
    const dir = join(tmpdir(), `ocr-reocr-trace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(rowsDir(dir), { recursive: true });
    try {
      const ocrFile = rowFilePath("ocr", dateLocalForTest(), dir);
      writeFileSync(
        ocrFile,
        JSON.stringify({
          workflow: "ocr",
          id: "s-trace",
          runId: "r-trace",
          status: "done",
          step: "awaiting-approval",
          timestamp: "2026-06-11T00:00:00Z",
          data: {
            formType: "oath",
            pdfPath: "/tmp/fake.pdf",
            pdfOriginalName: "fake.pdf",
            sessionId: "s-trace",
            // The OCR root's frozen trace id — its prefix is `ou-090553`.
            __traceId: "ou-090553-abcd",
            records: JSON.stringify([]),
            failedPages: JSON.stringify([]),
            pageStatusSummary: JSON.stringify({ total: 0, succeeded: 0, failed: 0 }),
          },
        }) + "\n",
        "utf-8",
      );

      const { buildOcrReocrWholePdfHandler, _resetSessionLockForTests } = await import(
        "../../../src/tracker/dashboard/ocr/index.js"
      );
      _resetSessionLockForTests();

      const handler = buildOcrReocrWholePdfHandler({
        trackerDir: dir,
        _emitOverride: () => {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _wholePdfOverride: (async () => ({
          data: [{
            sourcePage: 1, rowIndex: 0, printedName: "Alice One",
            employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
            notes: [], documentType: "expected", originallyMissing: [],
          }],
          provider: "whole-pdf-stub", attempts: 1, cached: false,
        })) as any,
        _loadRosterOverride: async () => [],
        _watchChildRunsOverride: async () => [],
        // No _enqueueEidLookupOverride → exercises the REAL delegateToAllImpl path.
      });

      await handler({ sessionId: "s-trace", runId: "r-trace" });

      assert.equal(mocks.delegateCalls.length, 1, "one re-fan delegate call");
      assert.equal(
        mocks.delegateCalls[0]?.rootTracePrefix,
        "ou-090553",
        "re-fan forwards the OCR root's trace prefix (was minting fresh pl-… before)",
      );
      assert.equal(mocks.delegateCalls[0]?.parentRunId, "r-trace");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves pdfPath from the pending row when the latest snapshot dropped it (item-4a regression)", async () => {
    vi.resetModules();
    mocks.delegateCalls.length = 0;
    const { rowFilePath, rowsDir } = await import("../../../src/tracker/paths.js");
    const dir = join(tmpdir(), `ocr-reocr-pdfpath-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(rowsDir(dir), { recursive: true });
    try {
      const ocrFile = rowFilePath("ocr", dateLocalForTest(), dir);
      // The PENDING row carries pdfPath; the LATER snapshot re-stamps pdfFileId but
      // DROPS pdfPath (a transient FS path is not in the re-stamp set). Reading
      // pdfPath off the LATEST matching row 400'd every re-OCR past pending.
      const pending = JSON.stringify({
        workflow: "ocr", id: "s-pp", runId: "r-pp", status: "pending", step: "loading-roster",
        timestamp: "2026-06-11T00:00:00Z",
        data: {
          formType: "oath", pdfPath: "/tmp/fake.pdf", pdfFileId: "pf-pp",
          pdfOriginalName: "fake.pdf", sessionId: "s-pp", __traceId: "ou-090553-abcd",
        },
      });
      const snapshot = JSON.stringify({
        workflow: "ocr", id: "s-pp", runId: "r-pp", status: "done", step: "awaiting-approval",
        timestamp: "2026-06-11T00:01:00Z",
        data: {
          formType: "oath", pdfFileId: "pf-pp", pdfOriginalName: "fake.pdf", sessionId: "s-pp",
          __traceId: "ou-090553-abcd", records: JSON.stringify([]), failedPages: JSON.stringify([]),
          pageStatusSummary: JSON.stringify({ total: 1, succeeded: 1, failed: 0 }),
        },
      });
      writeFileSync(ocrFile, pending + "\n" + snapshot + "\n", "utf-8");

      const { buildOcrReocrWholePdfHandler, _resetSessionLockForTests } = await import(
        "../../../src/tracker/dashboard/ocr/index.js"
      );
      _resetSessionLockForTests();

      const handler = buildOcrReocrWholePdfHandler({
        trackerDir: dir,
        _emitOverride: () => {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _wholePdfOverride: (async () => ({
          data: [{
            sourcePage: 1, rowIndex: 0, printedName: "Alice One",
            employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
            notes: [], documentType: "expected", originallyMissing: [],
          }],
          provider: "whole-pdf-stub", attempts: 1, cached: false,
        })) as any,
        _loadRosterOverride: async () => [],
        _watchChildRunsOverride: async () => [],
      });

      const res = await handler({ sessionId: "s-pp", runId: "r-pp" });
      assert.notEqual(
        res.status,
        400,
        `must not 400 'Row missing pdfPath' when only the pending row has pdfPath (got ${JSON.stringify(res.body)})`,
      );
      assert.equal(res.body.ok, true);
      assert.equal(mocks.delegateCalls.length, 1, "re-fan proceeded past the pdfPath check");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
