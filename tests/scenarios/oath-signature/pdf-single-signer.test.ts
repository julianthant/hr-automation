import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import { createScenarioRuntime, snapshotRow } from "../_runtime/index.js";
import { oathSignatureWorkflow } from "../../../src/workflows/oath-signature/workflow.js";
import { oathPdfBeats, oathSignatureBeats, maskVolatile } from "./_beats.js";

/**
 * Scenario: a PDF that resolves to one signer. The PDF parent is a batch
 * row because the PDF path represents a person set after OCR approval.
 * Signer children stay grouped under that parent as batch members even
 * when the approved set has N=1.
 *
 * Scenario-harness limitation: the runtime doesn't model the real
 * `ctx.delegateToAll` daemon dispatch. This test enqueues the signer
 * child explicitly via a second `rt.enqueue`, passing the same parent run
 * and row-shape hint that `delegateToAll(..., { renderAs: "batch" })`
 * applies in production.
 */
describe("oath-signature scenario: pdf branch — single signer", () => {
  test("N=1 → pdf row terminates done; signer remains grouped as a batch member", async (t) => {
    const rt = await createScenarioRuntime({ workflow: oathSignatureWorkflow });
    t.onTestFinished(() => rt.cleanup());

    // 1) PDF-branch row
    const pdfInput = {
      kind: "pdf" as const,
      pdfPath: "/tmp/oath-single.pdf",
      pdfOriginalName: "oath-single.pdf",
      sessionId: "scenario-pdf-single",
    };
    const pdfHandle = rt.enqueue(pdfInput, {
      itemId: pdfInput.sessionId,
      beats: oathPdfBeats(pdfInput),
    });
    assert.equal((await pdfHandle.result).ok, true);

    // 2) The one signer that came out of OCR approval. PDF approval is a
    //    batch path even when only one signer is selected.
    const signerInput = {
      kind: "signer" as const,
      emplId: "10000050",
      name: "Solo Signer",
      __runtimeOptions: { rowShape: "batch-member" as const },
    };
    const signerHandle = rt.enqueue(signerInput, {
      itemId: signerInput.emplId,
      parentRunId: pdfHandle.runId,
      beats: oathSignatureBeats(signerInput),
    });
    assert.equal((await signerHandle.result).ok, true);

    const pdfSnap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId: pdfHandle.runId,
      workflowLabel: oathSignatureWorkflow.config.label,
    });
    const signerSnap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId: signerHandle.runId,
      workflowLabel: oathSignatureWorkflow.config.label,
    });

    assert.equal(pdfSnap.status, "done");
    assert.equal(pdfSnap.archetype, "batch");
    assert.equal(signerSnap.status, "done");
    assert.equal(
      signerSnap.archetype,
      "batch-member",
      "PDF fan-out signer rows stay batch members, even for N=1",
    );
    assert.equal(signerSnap.parentRunId, pdfHandle.runId);

    expect([
      maskVolatile(pdfSnap),
      maskVolatile(signerSnap),
    ]).toMatchSnapshot();
  });
});
