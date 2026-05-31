import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import { createScenarioRuntime, snapshotRow } from "../_runtime/index.js";
import { oathSignatureWorkflow } from "../../../src/workflows/oath-signature/workflow.js";
import { oathSignatureBeats, maskVolatile } from "./_beats.js";

/**
 * Scenario: the `transaction` step throws a regular Error (not a cancel).
 *
 * Dashboard contract:
 *   - Row ends `failed`, NOT `failed + step:cancelled` — so the badge stays
 *     red "Failed" instead of amber "Cancelled".
 *   - `error` field carries the thrown message so the dashboard's error
 *     summary surface picks it up.
 *   - `result.kind` is `undefined` (not `"cancelled"`) — distinct from the
 *     cancel scenario's return value.
 */
describe("oath-signature scenario: fail during transaction", () => {
  test("transaction throws — row is Failed (not Cancelled)", async (t) => {
    const rt = await createScenarioRuntime({ workflow: oathSignatureWorkflow });
    t.onTestFinished(() => rt.cleanup());

    const input = { kind: "signer" as const, emplId: "10873698", name: "Jane Doe" };
    const failError = new Error("UCPath Save button was not visible after 10s");
    const { runId, result } = rt.enqueue(input, {
      itemId: input.emplId,
      beats: oathSignatureBeats(input, {
        throwAt: { step: "transaction", error: failError },
      }),
    });

    const res = await result;
    assert.equal(res.ok, false);
    assert.equal(res.kind, undefined); // crucial — distinguishes fail from cancel

    const failedSnap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId,
      workflowLabel: oathSignatureWorkflow.config.label,
    });
    expect(maskVolatile(failedSnap)).toMatchInlineSnapshot(`
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
          "date": "05/01/2026",
          "emplId": "10873698",
          "instance": "<instance>",
          "name": "Jane Doe",
        },
        "displayId": "10873698",
        "error": "UCPath Save button was not visible after 10s",
        "itemId": "<itemId>",
        "parentRunId": null,
        "rowTypeLabel": "Single",
        "runId": "<runId>",
        "status": "failed",
        "statusLabel": "Failed",
        "step": "transaction",
        "subtitle": "10873698",
        "surfacePlacement": "flat",
        "surfaceType": "single",
        "title": "Oath Signature EID 10873698",
        "workflow": "oath-signature",
      }
    `);
  });
});
