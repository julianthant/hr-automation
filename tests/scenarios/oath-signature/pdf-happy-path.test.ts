import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import { createScenarioRuntime, snapshotRow } from "../_runtime/index.js";
import { oathSignatureWorkflow } from "../../../src/workflows/oath-signature/workflow.js";
import { oathPdfBeats, maskVolatile } from "./_beats.js";

/**
 * Scenario: PDF-branch happy path. An oath-signature `{ kind: "pdf" }` row
 * runs through `ocr` (operator-approval surrogate) and `fan-out` and
 * terminates `done`.
 *
 * The harness has no OCR delegation integration today — the beats stand
 * in for the real `ctx.delegateTo(ocrWorkflow, ...)` +
 * `ctx.delegateToAll(oathSignatureWorkflow, ...)` calls. This test
 * therefore locks the **PDF row's** dashboard contract (status badges,
 * archetype, surface), NOT the downstream fan-out child rows (those run
 * through the daemon path which the scenario harness doesn't model).
 *
 * Dashboard contract for the PDF row:
 *   - `archetype: "batch"` (resolved via the workflow's archetype
 *     resolver for `kind: "pdf"` inputs).
 *   - Title comes from `pdfOriginalName` (set in `getName` for pdf
 *     inputs).
 *   - Terminal state: `done` with no `step` set (kernel emits the bare
 *     done row after the handler returns).
 */
describe("oath-signature scenario: pdf branch happy path", () => {
  test("pdf-branch row completes through ocr + fan-out", async (t) => {
    const rt = await createScenarioRuntime({ workflow: oathSignatureWorkflow });
    t.onTestFinished(() => rt.cleanup());

    const input = {
      kind: "pdf" as const,
      pdfPath: "/tmp/oath-test.pdf",
      pdfOriginalName: "oath-test.pdf",
      sessionId: "scenario-pdf-001",
    };
    const { runId, result } = rt.enqueue(input, {
      itemId: input.sessionId,
      beats: oathPdfBeats(input),
    });

    const res = await result;
    assert.equal(res.ok, true);

    const snap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId,
      workflowLabel: oathSignatureWorkflow.config.label,
    });
    assert.equal(snap.status, "done", "pdf-branch row should reach terminal done");
    assert.equal(snap.archetype, "batch", "pdf inputs resolve to batch archetype");

    // Lock the full row shape — captures everything the dashboard renders.
    expect(maskVolatile(snap)).toMatchSnapshot();
  });
});
