import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import { createScenarioRuntime, snapshotRow } from "../_runtime/index.js";
import { oathSignatureWorkflow } from "../../../src/workflows/oath-signature/workflow.js";
import { oathPdfBeats, maskVolatile } from "./_beats.js";

/**
 * Scenario: operator cancels a PDF-branch row while it's awaiting OCR
 * approval. The cancel happens DURING the `ocr` step (which in production
 * is `ctx.delegateTo(ocrWorkflow, ...)` suspended on
 * `subscribeToApproval`); the cancel must abort the OCR delegation and
 * the fan-out step must never run.
 *
 * Dashboard contract:
 *   - Row terminates `failed step=cancelled` — the standard cancel shape
 *     for any oath-signature run (same as cancel-during-transaction.test.ts
 *     for the signer branch).
 *   - `fan-out` was never reached — the dashboard StepPipeline shows
 *     `ocr` cancelled, `fan-out` never entered (it's a skipStep-eligible
 *     pipeline slot but the handler never got there).
 */
describe("oath-signature scenario: pdf branch — cancel during ocr approval", () => {
  test("cancel during ocr-await aborts handler; fan-out never runs", async (t) => {
    const rt = await createScenarioRuntime({ workflow: oathSignatureWorkflow });
    t.onTestFinished(() => rt.cleanup());

    const input = {
      kind: "pdf" as const,
      pdfPath: "/tmp/oath-cancel.pdf",
      pdfOriginalName: "oath-cancel.pdf",
      sessionId: "scenario-pdf-cancel",
    };
    const { runId, result } = rt.enqueue(input, {
      itemId: input.sessionId,
      beats: oathPdfBeats(input, { holdAt: "ocr" }),
    });

    // Wait for the ocr step to enter its held body.
    await rt.waitForStepStart("ocr");
    await rt.cancelRow(runId);
    await rt.waitForTerminal(runId);

    const res = await result;
    assert.equal(res.ok, false);
    assert.equal(res.kind, "cancelled");

    const snap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId,
      workflowLabel: oathSignatureWorkflow.config.label,
    });
    assert.equal(snap.status, "failed");
    assert.equal(snap.step, "cancelled");
    // Cancel preserves the row's batch archetype — the cancel
    // marker is a status change, not a row-type change.
    assert.equal(snap.archetype, "batch");

    expect(maskVolatile(snap)).toMatchSnapshot();
  });
});
