import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import { createScenarioRuntime, snapshotRow } from "../_runtime/index.js";
import { oathSignatureWorkflow } from "../../../src/workflows/oath-signature/workflow.js";
import { oathSignatureBeats, maskVolatile } from "./_beats.js";

/**
 * Scenario: first run fails, operator clicks Retry, second run succeeds.
 *
 * Production path: `/api/retry` re-enqueues the same itemId with a new
 * runId. The dashboard surface shows the latest run by default and exposes
 * older runs via `RunSelector`. Both runs share the itemId; their runIds
 * differ.
 *
 * Dashboard contract:
 *   - First run terminal snapshot: `failed` with the error.
 *   - Retry terminal snapshot: `done` with no error.
 *   - Same itemId across both runs; distinct runIds.
 */
describe("oath-signature scenario: retry after failure", () => {
  test("first run fails, retry succeeds — latest run is Done", async (t) => {
    const rt = await createScenarioRuntime({ workflow: oathSignatureWorkflow });
    t.onTestFinished(() => rt.cleanup());

    const input = { kind: "signer" as const, emplId: "10873698", name: "Jane Doe" };

    // ── First run: scripted to throw inside transaction ──
    const first = rt.enqueue(input, {
      itemId: input.emplId,
      beats: oathSignatureBeats(input, {
        throwAt: { step: "transaction", error: new Error("transient UCPath outage") },
      }),
    });
    const firstRes = await first.result;
    assert.equal(firstRes.ok, false);
    assert.equal(firstRes.kind, undefined);

    const firstSnap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId: first.runId,
      workflowLabel: oathSignatureWorkflow.config.label,
    });
    expect(maskVolatile(firstSnap)).toMatchInlineSnapshot(`
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
        "error": "transient UCPath outage",
        "itemId": "<itemId>",
        "parentRunId": null,
        "rowTypeLabel": "Normal row",
        "runId": "<runId>",
        "status": "failed",
        "statusLabel": "Failed",
        "step": "transaction",
        "subtitle": "10873698",
        "surfacePlacement": "flat",
        "surfaceType": "normal",
        "title": "Oath Signature EID 10873698",
        "workflow": "oath-signature",
      }
    `);

    // ── Retry: same itemId, fresh runId, scripted to succeed ──
    const retry = rt.enqueue(input, {
      itemId: input.emplId, // same itemId — production retry reuses it
      beats: oathSignatureBeats(input),
    });
    const retryRes = await retry.result;
    assert.equal(retryRes.ok, true);

    // Same item, different run.
    assert.equal(retry.itemId, first.itemId);
    assert.notEqual(retry.runId, first.runId);

    const retrySnap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId: retry.runId,
      workflowLabel: oathSignatureWorkflow.config.label,
    });
    expect(maskVolatile(retrySnap)).toMatchInlineSnapshot(`
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
