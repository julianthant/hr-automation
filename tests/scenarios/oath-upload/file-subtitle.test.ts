import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import { createScenarioRuntime, snapshotRow } from "../_runtime/index.js";
import { oathUploadWorkflow } from "../../../src/workflows/oath-upload/workflow.js";
import { oathUploadSteps } from "../../../src/workflows/oath-upload/handler.js";
import type { ScenarioBeat } from "../_runtime/index.js";

/**
 * Scenario: a standalone oath-upload run. oath-upload's `inputSubject` is
 * `pdf`, so its `queueRowKind` is `file`. The dashboard contract for a file
 * row is: TITLE = the PDF filename, SUBTITLE = the TRACE ID — never an EID.
 *
 * This pins the file-kind subtitle rule for a flat single row. (Unlike the
 * person kind, the file/catalog subtitle is the trace id regardless of
 * `preferTraceIdSubtitle`, so a flat file row already shows it.) Together with
 * the OCR preview group-anchor test, it covers file-kind subtitle on both the
 * flat-row and group-card projection paths.
 */
const uploadBeats = (pdfOriginalName: string, ticketNumber: string): ScenarioBeat[] => [
  // The real oathUploadHandler stamps pdfOriginalName onto the row data so the
  // file-kind title resolves to the filename. The kernel's getName reads from
  // data, not the raw input, so the scripted beats must do the same.
  { kind: "updateData", data: { pdfOriginalName } },
  { kind: "step", name: "wait-signatures" },
  { kind: "step", name: "servicenow-auth" },
  { kind: "step", name: "open-hr-form" },
  { kind: "step", name: "fill-form" },
  {
    kind: "step",
    name: "submit",
    updateData: { ticketNumber },
  },
];

describe("oath-upload scenario: file-kind subtitle is the trace id", () => {
  test("a completed oath-upload row titles by PDF name and subtitles by trace id", async (t) => {
    // oathUploadSteps is referenced so the import stays load-bearing — it
    // documents that the scripted beats below mirror the real step list.
    assert.deepEqual(Array.from(oathUploadSteps), [
      "wait-signatures",
      "servicenow-auth",
      "open-hr-form",
      "fill-form",
      "submit",
    ]);

    const rt = await createScenarioRuntime({ workflow: oathUploadWorkflow });
    t.onTestFinished(() => rt.cleanup());

    const input = {
      pdfPath: "/tmp/signed-oaths.pdf",
      pdfOriginalName: "signed-oaths.pdf",
      sessionId: "oath-upload-session-1",
      mode: "upload-only" as const,
      rosterMode: "existing" as const,
    };
    const { runId, result } = rt.enqueue(input, {
      itemId: input.sessionId,
      runId: "oath-upload-session-1#run",
      beats: uploadBeats("signed-oaths.pdf", "HRC0012345"),
    });

    const res = await result;
    assert.equal(res.ok, true);

    const snap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId,
      workflowLabel: oathUploadWorkflow.config.label,
    });

    assert.equal(snap.archetype, "single");
    assert.equal(snap.data.queueRowKind, "file");
    assert.equal(snap.title, "signed-oaths.pdf", "file-kind title = PDF filename");
    assert.equal(snap.subtitle, "<traceId>", "file-kind subtitle = trace id, not an EID/sessionId");
    assert.equal(snap.statusLabel, "Done");

    expect(snap).toMatchInlineSnapshot(`
      {
        "archetype": "single",
        "data": {
          "__id": "",
          "__name": "signed-oaths.pdf",
          "__subject": "Oath Upload signed-oaths.pdf",
          "__subjectKind": "pdf",
          "__traceId": "<traceId>",
          "archetype": "single",
          "instance": "Oath Upload 1",
          "pdfOriginalName": "signed-oaths.pdf",
          "queueRowKind": "file",
          "ticketNumber": "HRC0012345",
        },
        "displayId": "<traceId>",
        "itemId": "oath-upload-session-1",
        "parentRunId": null,
        "rowTypeLabel": "Single",
        "runId": "oath-upload-session-1#run",
        "status": "done",
        "statusLabel": "Done",
        "step": undefined,
        "subtitle": "<traceId>",
        "surfacePlacement": "flat",
        "surfaceType": "single",
        "title": "signed-oaths.pdf",
        "workflow": "oath-upload",
      }
    `);
  });
});
