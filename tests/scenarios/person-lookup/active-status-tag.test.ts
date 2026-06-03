import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import { createScenarioRuntime, snapshotRow } from "../_runtime/index.js";
import { personLookupWorkflow } from "../../../src/workflows/person-lookup/workflow.js";
import { personLookupBeats } from "./_beats.js";

/**
 * Scenario: an EID person-lookup that resolves to an active / inactive
 * employee. The dashboard renders the base "Done" badge PLUS a secondary
 * status chip (A / IA) from person-lookup's `secondaryTag` rule. This is the
 * other half of `statusExtensions` the Step-2 fix made visible — the old
 * `snapshotRow` had no notion of a secondary tag at all.
 */
describe("person-lookup scenario: active-status secondary tag", () => {
  test("an active employee carries the 'A' secondary tag alongside Done", async (t) => {
    const rt = await createScenarioRuntime({ workflow: personLookupWorkflow });
    t.onTestFinished(() => rt.cleanup());

    const input = { emplId: "10000001" };
    const { runId, result } = rt.enqueue(input, {
      runId: "pl-active#run",
      beats: personLookupBeats({
        searchName: "10000001",
        emplId: "10000001",
        activeStatus: "active",
        finalData: { department: "HDH Dining", hrStatus: "Active" },
      }),
    });

    const res = await result;
    assert.equal(res.ok, true);

    const snap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId,
      workflowLabel: personLookupWorkflow.config.label,
    });

    assert.equal(snap.status, "done");
    assert.equal(snap.statusLabel, "Done", "base badge stays Done — the tag is supplemental");
    assert.deepEqual(snap.secondaryTag, { text: "A", title: "Active" });

    expect(snap).toMatchInlineSnapshot(`
      {
        "archetype": "single",
        "data": {
          "__id": "10000001",
          "__name": "10000001",
          "__queueTitle": "EID 10000001",
          "__queueTitleKind": "single",
          "__subject": "EID 10000001",
          "__subjectKind": "eid",
          "__traceId": "<traceId>",
          "activeStatus": "active",
          "archetype": "single",
          "department": "HDH Dining",
          "emplId": "10000001",
          "hrStatus": "Active",
          "instance": "Person Lookup 1",
          "queueRowKind": "person",
          "searchName": "10000001",
        },
        "displayId": "10000001",
        "itemId": "10000001",
        "parentRunId": null,
        "rowTypeLabel": "Single",
        "runId": "pl-active#run",
        "secondaryTag": {
          "text": "A",
          "title": "Active",
        },
        "status": "done",
        "statusLabel": "Done",
        "step": undefined,
        "subtitle": "10000001",
        "surfacePlacement": "flat",
        "surfaceType": "single",
        "title": "10000001",
        "workflow": "person-lookup",
      }
    `);
  });

  test("an inactive employee carries the 'IA' secondary tag", async (t) => {
    const rt = await createScenarioRuntime({ workflow: personLookupWorkflow });
    t.onTestFinished(() => rt.cleanup());

    const input = { emplId: "10000002" };
    const { runId, result } = rt.enqueue(input, {
      runId: "pl-inactive#run",
      beats: personLookupBeats({
        searchName: "10000002",
        emplId: "10000002",
        activeStatus: "inactive",
        finalData: { hrStatus: "Terminated" },
      }),
    });

    const res = await result;
    assert.equal(res.ok, true);

    const snap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId,
      workflowLabel: personLookupWorkflow.config.label,
    });

    assert.equal(snap.statusLabel, "Done");
    assert.deepEqual(snap.secondaryTag, { text: "IA", title: "Inactive" });
  });
});
