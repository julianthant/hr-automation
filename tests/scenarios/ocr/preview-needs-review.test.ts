import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import {
  createScenarioRuntime,
  snapshotRow,
  snapshotGroupAnchor,
} from "../_runtime/index.js";
import { ocrWorkflow } from "../../../src/workflows/ocr/workflow.js";
import { ocrPrepBeats } from "./_beats.js";

/**
 * Scenario: a DELEGATED OCR prep run parked at `awaiting-approval`.
 *
 * Dashboard contract this locks (and validates the Step-2 harness fidelity fix):
 *   1. `preview` archetype — the OCR row is a preview surface, not a flat row.
 *   2. `needsReview` DERIVED status (statusExtensions) — a delegated OCR row
 *      (`parentRunId` set) at `running step=awaiting-approval` reads
 *      "Needs review", NOT "Running". Before the harness fix, snapshotRow
 *      reimplemented status logic and could never see this.
 *   3. The row groups into a PREVIEW surface card (not a flat row).
 *   4. The group-anchor footer SUBTITLE is the TRACE ID (file kind +
 *      `preferTraceIdSubtitle`), surfaced via `snapshotGroupAnchor` — the
 *      group-card projection path `snapshotRow` never exercised.
 */
describe("ocr scenario: delegated preview awaiting approval (needs review)", () => {
  test("delegated OCR prep parked at awaiting-approval renders needs-review preview", async (t) => {
    const rt = await createScenarioRuntime({ workflow: ocrWorkflow });
    t.onTestFinished(() => rt.cleanup());

    const input = {
      pdfPath: "/tmp/oaths.pdf",
      pdfOriginalName: "oaths-batch.pdf",
      sessionId: "ocr-session-1",
      formType: "oath",
      rosterMode: "existing" as const,
    };
    const parentRunId = "oath-upload-parent-run-1";

    // Fixed runId so the snapshot's `runId` field is deterministic (the kernel
    // would otherwise mint `<sessionId>#<random>`).
    const { runId, result } = rt.enqueue(input, {
      itemId: input.sessionId,
      runId: "ocr-session-1#run",
      parentRunId,
      beats: ocrPrepBeats(input, { holdAtApproval: true }),
    });

    // Wait until the run is parked at awaiting-approval (running row on disk).
    await rt.waitForStepStart("awaiting-approval");

    const reviewSnap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId,
      workflowLabel: ocrWorkflow.config.label,
    });

    // The derived status appears ONLY because the harness now routes through
    // the real resolveQueueRowStatus — the whole point of the Step-2 fix.
    assert.equal(reviewSnap.status, "running", "tracker status stays running until approval");
    assert.equal(reviewSnap.statusLabel, "Needs review", "delegated OCR awaiting-approval → needsReview");
    assert.equal(reviewSnap.archetype, "preview");
    assert.equal(reviewSnap.surfacePlacement, "grouped", "preview rows render inside a group card");
    assert.equal(reviewSnap.parentRunId, parentRunId);

    // Group-card projection: the anchor footer subtitle is the trace id (file
    // kind). This is the path snapshotRow never takes — snapshotGroupAnchor
    // exercises buildProjectionFromQueueSurface + preferTraceIdSubtitle.
    const anchor = snapshotGroupAnchor({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      parentRunId: runId,
      workflowLabel: ocrWorkflow.config.label,
    });
    assert.equal(anchor.kind, "preview");
    assert.equal(anchor.surfaceType, "preview");
    assert.equal(anchor.rowTypeLabel, "Preview");
    assert.equal(anchor.title, "oaths-batch.pdf", "preview anchor title = PDF filename (file kind)");
    assert.equal(anchor.subtitle, "<traceId>", "preview anchor footer subtitle = trace id, not an EID");

    expect(reviewSnap).toMatchInlineSnapshot(`
      {
        "archetype": "preview",
        "data": {
          "__id": "ocr-session-1",
          "__name": "oaths-batch.pdf",
          "__queueTitle": "Oath",
          "__queueTitleKind": "batch",
          "__subject": "OCR oaths-batch.pdf",
          "__subjectKind": "pdf",
          "__traceId": "<traceId>",
          "archetype": "preview",
          "formType": "oath",
          "instance": "OCR 1",
          "mode": "prepare",
          "pdfOriginalName": "oaths-batch.pdf",
          "queueRowKind": "file",
          "recordCount": "1",
          "sessionId": "ocr-session-1",
        },
        "displayId": "<traceId>",
        "itemId": "ocr-session-1",
        "parentRunId": "oath-upload-parent-run-1",
        "rowTypeLabel": "Preview",
        "runId": "ocr-session-1#run",
        "status": "running",
        "statusLabel": "Needs review",
        "step": "awaiting-approval",
        "subtitle": "<traceId>",
        "surfacePlacement": "grouped",
        "surfaceType": "preview",
        "title": "oaths-batch.pdf",
        "workflow": "ocr",
      }
    `);
    expect(anchor).toMatchInlineSnapshot(`
      {
        "kind": "preview",
        "memberCount": 0,
        "rowTypeLabel": "Preview",
        "status": "running",
        "subtitle": "<traceId>",
        "surfaceType": "preview",
        "title": "oaths-batch.pdf",
        "workflowId": "ocr",
      }
    `);

    // Let the held step finish so the run terminates cleanly (no leaked promise).
    rt.releaseHold("awaiting-approval");
    const res = await result;
    assert.equal(res.ok, true);
  });
});
