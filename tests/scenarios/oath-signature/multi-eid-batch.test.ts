import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import { createScenarioRuntime, snapshotRow, snapshotGroupAnchor } from "../_runtime/index.js";
import { oathSignatureWorkflow } from "../../../src/workflows/oath-signature/workflow.js";
import { oathSignatureBeats, maskVolatile } from "./_beats.js";

/**
 * Scenario: operator enqueues N EIDs in one dashboard input run. Because
 * the run contains multiple people, each EID becomes a batch member
 * under the input-run batch card.
 *
 * Dashboard contract:
 *   - One batch group card with N member rows.
 *   - Each row's title comes from the per-row `__queueTitle` (operator
 *     subject), so the queue reads as a stack of "Oath Signature EID …".
 *   - Every member carries the shared input-run `parentRunId`.
 */
describe("oath-signature scenario: multi-EID batch", () => {
  test("three EIDs enqueued together — three batch-member rows complete", async (t) => {
    const rt = await createScenarioRuntime({ workflow: oathSignatureWorkflow });
    t.onTestFinished(() => rt.cleanup());

    const parentRunId = "scenario-input-batch-1";
    const inputs = [
      {
        emplId: "10000001",
        name: "Alice Smith",
        __runtimeOptions: { rowShape: "batch-member" as const },
      },
      {
        emplId: "10000002",
        name: "Bob Jones",
        __runtimeOptions: { rowShape: "batch-member" as const },
      },
      {
        emplId: "10000003",
        name: "Carol Lee",
        __runtimeOptions: { rowShape: "batch-member" as const },
      },
    ];

    const handles = inputs.map((input) =>
      rt.enqueue(input, {
        itemId: input.emplId,
        parentRunId,
        beats: oathSignatureBeats(input),
      }),
    );

    const results = await Promise.all(handles.map((h) => h.result));
    assert.equal(results.every((r) => r.ok), true, "every run completed successfully");

    const snaps = handles.map((h) => maskVolatile(snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId: h.runId,
      workflowLabel: oathSignatureWorkflow.config.label,
    })));

    // Lock the shape of every row. Names differ; the rest of the contract
    // (status, archetype, surface, etc.) is identical across rows.
    expect(snaps).toMatchInlineSnapshot(`
      [
        {
          "archetype": "batch-member",
          "data": {
            "__id": "10000001",
            "__name": "Alice Smith",
            "__queueTitle": "Oath Signature EID 10000001",
            "__queueTitleKind": "single",
            "__subject": "Oath Signature EID 10000001",
            "__subjectKind": "eid",
            "__traceId": "<traceId>",
            "archetype": "batch-member",
            "date": "05/01/2026",
            "emplId": "10000001",
            "instance": "<instance>",
            "name": "Alice Smith",
            "queueRowKind": "person",
          },
          "displayId": "10000001",
          "itemId": "<itemId>",
          "parentRunId": "scenario-input-batch-1",
          "rowTypeLabel": "Single",
          "runId": "<runId>",
          "status": "done",
          "statusLabel": "Done",
          "step": undefined,
          "subtitle": "10000001",
          "surfacePlacement": "grouped",
          "surfaceType": "single",
          "title": "Alice Smith",
          "workflow": "oath-signature",
        },
        {
          "archetype": "batch-member",
          "data": {
            "__id": "10000002",
            "__name": "Bob Jones",
            "__queueTitle": "Oath Signature EID 10000002",
            "__queueTitleKind": "single",
            "__subject": "Oath Signature EID 10000002",
            "__subjectKind": "eid",
            "__traceId": "<traceId>",
            "archetype": "batch-member",
            "date": "05/01/2026",
            "emplId": "10000002",
            "instance": "<instance>",
            "name": "Bob Jones",
            "queueRowKind": "person",
          },
          "displayId": "10000002",
          "itemId": "<itemId>",
          "parentRunId": "scenario-input-batch-1",
          "rowTypeLabel": "Single",
          "runId": "<runId>",
          "status": "done",
          "statusLabel": "Done",
          "step": undefined,
          "subtitle": "10000002",
          "surfacePlacement": "grouped",
          "surfaceType": "single",
          "title": "Bob Jones",
          "workflow": "oath-signature",
        },
        {
          "archetype": "batch-member",
          "data": {
            "__id": "10000003",
            "__name": "Carol Lee",
            "__queueTitle": "Oath Signature EID 10000003",
            "__queueTitleKind": "single",
            "__subject": "Oath Signature EID 10000003",
            "__subjectKind": "eid",
            "__traceId": "<traceId>",
            "archetype": "batch-member",
            "date": "05/01/2026",
            "emplId": "10000003",
            "instance": "<instance>",
            "name": "Carol Lee",
            "queueRowKind": "person",
          },
          "displayId": "10000003",
          "itemId": "<itemId>",
          "parentRunId": "scenario-input-batch-1",
          "rowTypeLabel": "Single",
          "runId": "<runId>",
          "status": "done",
          "statusLabel": "Done",
          "step": undefined,
          "subtitle": "10000003",
          "surfacePlacement": "grouped",
          "surfaceType": "single",
          "title": "Carol Lee",
          "workflow": "oath-signature",
        },
      ]
    `);

    // Group-card projection for the SAME batch surface. A person batch anchor
    // has NO title (the count badge + member-name preview identify it), and its
    // footer SUBTITLE is the TRACE ID — `preferTraceIdSubtitle: true` so the
    // footer doesn't repeat an EID already shown on each member's title line.
    // This is the rule snapshotRow's per-row projection never exercises; flip
    // `preferTraceIdSubtitle` off in buildProjectionFromQueueSurface and this
    // anchor subtitle regresses to a member EID, failing here.
    const anchor = snapshotGroupAnchor({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      parentRunId,
      workflowLabel: oathSignatureWorkflow.config.label,
    });
    assert.equal(anchor.kind, "batch");
    assert.equal(anchor.title, "", "person batch anchor carries no synthetic title");
    assert.equal(anchor.subtitle, "<traceId>", "person batch anchor footer subtitle = trace id, never a member EID");
    expect(anchor).toMatchInlineSnapshot(`
      {
        "kind": "batch",
        "memberCount": 3,
        "rowTypeLabel": "Batch",
        "status": "done",
        "subtitle": "<traceId>",
        "surfaceType": "batch",
        "title": "",
        "workflowId": "oath-signature",
      }
    `);
  });
});
