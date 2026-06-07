import { describe, it, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real `ocrKernelHandler` delegates to `runOcrOrchestrator`. Mock the
// orchestrator so the test can drive each terminal outcome directly (the heavy
// LLM/roster/lookup pipeline is exercised by `orchestrator.test.ts`).
//
// `vi.resetModules()` + the dynamic `import()` inside each test is required so
// the mock intercept is applied BEFORE `workflow.ts` captures its
// `runOcrOrchestrator` binding — a static top-level import would bind the real
// function first (same pattern as `ctx-delegate-to-daemon.test.ts`).
const { runOcrOrchestratorMock } = vi.hoisted(() => ({
  runOcrOrchestratorMock: vi.fn(),
}));

vi.resetModules();

vi.mock("../../../../src/workflows/ocr/orchestrator.js", () => ({
  runOcrOrchestrator: runOcrOrchestratorMock,
}));

import type { OcrInput } from "../../../../src/workflows/ocr/schema.js";

type AnyCtx = Record<string, unknown>;

function makeCtx(updateData: ReturnType<typeof vi.fn>): AnyCtx {
  const trackerDir = mkdtempSync(join(tmpdir(), "ocr-wf-test-"));
  return {
    runId: "ocr-run-1",
    trackerDir,
    signal: new AbortController().signal,
    parentRunId: undefined,
    reportPhase: vi.fn(),
    updateData,
  };
}

const standaloneInput = {
  sessionId: "sess-1",
  formType: "verify",
  pdfOriginalName: "scan.pdf",
} as unknown as OcrInput;

async function loadHandler() {
  const { ocrWorkflow } = await import("../../../../src/workflows/ocr/index.js");
  return ocrWorkflow.config.handler as unknown as (ctx: AnyCtx, input: OcrInput) => Promise<void>;
}

describe("ocrKernelHandler (ocrWorkflow.config.handler)", () => {
  beforeEach(() => {
    runOcrOrchestratorMock.mockReset();
  });

  it("seeds the rich review payload (mode:prepare) when a standalone run completes", async () => {
    // A standalone run reaches person-lookup and the orchestrator returns the
    // 2026-06-06 `complete` outcome AFTER emitting its own rich terminal `done`
    // snapshot. The handler must seed that payload onto accumulated ctx data so
    // the kernel's auto-emitted terminal `done` row stays a preview row instead
    // of clobbering the rich one with a sparse, title-less row.
    runOcrOrchestratorMock.mockImplementation(async (_input, opts) => {
      opts.onReviewData?.({
        pdfOriginalName: "scan.pdf",
        records: JSON.stringify([{ name: "Jordan" }]),
        formType: "verify",
        mode: "prepare",
        // kernel-owned delegated scope — must be stripped from `data`.
        parentRunId: "kernel-owned",
      });
      return { status: "complete" };
    });

    const handler = await loadHandler();
    const updateData = vi.fn();
    const ctx = makeCtx(updateData);

    await handler(ctx, standaloneInput);

    assert.equal(
      updateData.mock.calls.length,
      1,
      "complete branch must seed the review payload via ctx.updateData",
    );
    const patch = updateData.mock.calls[0][0] as Record<string, unknown>;
    assert.equal(patch.mode, "prepare", "Preview gate keys on data.mode === 'prepare'");
    assert.equal(patch.pdfOriginalName, "scan.pdf", "file-kind title payload must survive");
    assert.ok(patch.records, "records must ride the terminal row for the completeness card");
    assert.equal(patch.formType, "verify");
    assert.ok(
      !("parentRunId" in patch),
      "kernel-owned parentRunId must be stripped from data",
    );
  });

  it("does NOT seed on a discarded outcome (the discard route owns the terminal row)", async () => {
    // Guards branch ordering: only `complete` (and the approve/failure paths)
    // seed data — `discarded` returns untouched so it can't accidentally inherit
    // the complete-branch seeding.
    runOcrOrchestratorMock.mockResolvedValue({ status: "discarded" });

    const handler = await loadHandler();
    const updateData = vi.fn();
    const ctx = makeCtx(updateData);

    await handler(ctx, standaloneInput);

    assert.equal(updateData.mock.calls.length, 0, "discard path must not call updateData");
  });
});
