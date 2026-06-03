import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import { createScenarioRuntime, snapshotRow } from "../_runtime/index.js";
import { personLookupWorkflow } from "../../../src/workflows/person-lookup/workflow.js";
import { personLookupBeats } from "./_beats.js";

/**
 * Scenario: a person-lookup name search where UCPath has no matching Person
 * Org row. The automation SUCCEEDED — tracker status is `done` — but the
 * dashboard must read "Not found", driven by person-lookup's `notFound`
 * derived status (`data.activeStatus === "not-found"`).
 *
 * This validates the Step-2 harness fix end-to-end: before it, `snapshotRow`
 * reimplemented status resolution via a local `isTerminalNotFoundEntry` call;
 * now it routes through the real `resolveQueueRowStatus` + the registered
 * `personLookupStatusExtensions`, so a regression in either the rule or its
 * registration surfaces in this snapshot.
 */
describe("person-lookup scenario: terminal not-found", () => {
  test("a name lookup with no UCPath match resolves to the 'Not found' label", async (t) => {
    const rt = await createScenarioRuntime({ workflow: personLookupWorkflow });
    t.onTestFinished(() => rt.cleanup());

    const input = { name: "Nonexistent Person" };
    const { runId, result } = rt.enqueue(input, {
      runId: "pl-notfound#run",
      beats: personLookupBeats({
        searchName: "Person, Nonexistent",
        activeStatus: "not-found",
      }),
    });

    const res = await result;
    assert.equal(res.ok, true, "the lookup itself succeeds — 'not found' is a business outcome");

    const snap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId,
      workflowLabel: personLookupWorkflow.config.label,
    });

    // Raw tracker status is still `done`; the dashboard LABEL is "Not found".
    assert.equal(snap.status, "done");
    assert.equal(snap.statusLabel, "Not found");
    // notFound is a status badge replacement, not a secondary chip.
    assert.equal(snap.secondaryTag, undefined);

    expect(snap).toMatchInlineSnapshot(`
      {
        "archetype": "single",
        "data": {
          "__id": "Person, Nonexistent",
          "__name": "Person, Nonexistent",
          "__queueTitle": "Nonexistent Person",
          "__queueTitleKind": "single",
          "__subject": "Nonexistent Person",
          "__subjectKind": "person",
          "__traceId": "<traceId>",
          "activeStatus": "not-found",
          "archetype": "single",
          "instance": "Person Lookup 1",
          "queueRowKind": "person",
          "searchName": "Person, Nonexistent",
        },
        "displayId": "<traceId>",
        "itemId": "Nonexistent Person",
        "parentRunId": null,
        "rowTypeLabel": "Single",
        "runId": "pl-notfound#run",
        "status": "done",
        "statusLabel": "Not found",
        "step": undefined,
        "subtitle": "<traceId>",
        "surfacePlacement": "flat",
        "surfaceType": "single",
        "title": "Person, Nonexistent",
        "workflow": "person-lookup",
      }
    `);
  });
});
