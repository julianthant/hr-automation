import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import { createScenarioRuntime, snapshotRow } from "../_runtime/index.js";
import { oathSignatureWorkflow } from "../../../src/workflows/oath-signature/workflow.js";
import { oathSignatureBeats, maskVolatile } from "./_beats.js";

/**
 * Scenario: one EID enqueued, scripted handler runs through every step
 * cleanly. This is the baseline contract — if the dashboard's row shape for
 * a completed run ever drifts (status, statusLabel, surfaceType, title), the
 * snapshot diff catches it.
 */
describe("oath-signature scenario: happy path (single EID)", () => {
  test("single-EID run completes through all 3 steps", async (t) => {
    const rt = await createScenarioRuntime({ workflow: oathSignatureWorkflow });
    t.onTestFinished(() => rt.cleanup());

    const input = { emplId: "10873698", name: "Jane Doe" };
    const { runId, result } = rt.enqueue(input, {
      itemId: input.emplId,
      beats: oathSignatureBeats(input),
    });

    const res = await result;
    assert.equal(res.ok, true);

    const doneSnap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId,
      workflowLabel: oathSignatureWorkflow.config.label,
    });
    expect(maskVolatile(doneSnap)).toMatchInlineSnapshot(`
      {
        "archetype": "single",
        "data": {
          "__id": "10873698",
          "__name": "Jane Doe",
          "__queueTitle": "Oath Signature EID 10873698",
          "__queueTitleKind": "single",
          "__subject": "Oath Signature EID 10873698",
          "__subjectKind": "eid",
          "archetype": "single",
          "emplId": "10873698",
          "instance": "<instance>",
          "name": "Jane Doe",
        },
        "displayId": "10873698",
        "itemId": "<itemId>",
        "parentRunId": null,
        "rowTypeLabel": "Normal row",
        "runId": "<runId>",
        "status": "done",
        "statusLabel": "Done",
        "step": undefined,
        "subtitle": "10873698",
        "surfacePlacement": "flat",
        "surfaceType": "normal",
        "title": "Oath Signature EID 10873698",
        "workflow": "oath-signature",
      }
    `);
  });
});
