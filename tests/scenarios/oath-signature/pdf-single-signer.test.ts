import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import { createScenarioRuntime, snapshotRow } from "../_runtime/index.js";
import { oathSignatureWorkflow } from "../../../src/workflows/oath-signature/workflow.js";
import { oathPdfBeats, oathSignatureBeats, maskVolatile } from "./_beats.js";

/**
 * Scenario: a PDF that resolves to one signer. Per the vocab doc's
 * "N≥2 fans out into a batch row; N=1 stays as a single row" rule, the
 * downstream signer is a flat single — no batch wrapper. The PDF parent
 * row itself is still a batch-parent (its archetype is fixed by the
 * resolver for `kind: "pdf"`).
 *
 * Scenario-harness limitation: the runtime doesn't model the real
 * `ctx.delegateToAll` daemon dispatch. This test enqueues the signer
 * child explicitly via a second `rt.enqueue` to mirror the row the
 * dashboard would see after a real `delegateToAll` with N=1.
 */
describe("oath-signature scenario: pdf branch — single signer", () => {
  test("N=1 → pdf row terminates done; signer is a flat single row", async (t) => {
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

    // 2) The one signer that came out of OCR approval. With N=1 the
    //    canonical rendering is a flat single row (no batch members card).
    const signerInput = {
      kind: "signer" as const,
      emplId: "10000050",
      name: "Solo Signer",
    };
    const signerHandle = rt.enqueue(signerInput, {
      itemId: signerInput.emplId,
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
    assert.equal(pdfSnap.archetype, "batch-parent");
    assert.equal(signerSnap.status, "done");
    assert.equal(
      signerSnap.archetype,
      "single",
      "N=1 fan-out degenerates to a single row, not a batch member",
    );

    expect([
      maskVolatile(pdfSnap),
      maskVolatile(signerSnap),
    ]).toMatchSnapshot();
  });
});
