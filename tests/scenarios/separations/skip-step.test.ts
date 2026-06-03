import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import {
  createScenarioRuntime,
  snapshotRow,
  readRowTimeline,
  type ScenarioBeat,
} from "../_runtime/index.js";
import { separationsWorkflow } from "../../../src/workflows/separations/workflow.js";

/**
 * Scenario: a separations run where the `kronos-search` step is intentionally
 * bypassed via `ctx.skipStep` (the "Transactions only" preset skips
 * kronos-search + ucpath-job-summary). Models the edit-and-resume / preset
 * skip path.
 *
 * Dashboard contract:
 *   - The skipped step emits a distinct `status: "skipped"` row (the pipeline
 *     renders it as skipped, not done) — surfaced here via the row timeline,
 *     which `StepPipeline` consumes.
 *   - The RUN still completes: the queue row's terminal status is `done`. An
 *     intermediate skip does not flip the whole row to "Skipped".
 */
const separationsSkipBeats: ScenarioBeat[] = [
  { kind: "updateData", data: { docId: "DOC-1", name: "Jane Doe", eid: "12345" } },
  { kind: "step", name: "kuali-extraction" },
  // "Transactions only" preset skips this step.
  { kind: "skipStep", name: "kronos-search" },
  { kind: "step", name: "ucpath-job-summary" },
  { kind: "step", name: "ucpath-transaction", updateData: { transactionNumber: "T-999" } },
  { kind: "step", name: "kuali-finalization" },
];

describe("separations scenario: skipStep bypasses kronos-search", () => {
  test("a skipped intermediate step surfaces a 'skipped' row while the run completes", async (t) => {
    const rt = await createScenarioRuntime({ workflow: separationsWorkflow });
    t.onTestFinished(() => rt.cleanup());

    const { runId, result } = rt.enqueue(
      { docId: "DOC-1" },
      { itemId: "DOC-1", runId: "sep-doc-1#run", beats: separationsSkipBeats },
    );

    const res = await result;
    assert.equal(res.ok, true);

    // The step timeline (what StepPipeline reads) must carry a distinct
    // `skipped` row for kronos-search — between the two real running steps.
    const timeline = readRowTimeline({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId,
    });
    const stepShape = timeline.map((e) => `${e.status}/${e.step ?? ""}`);
    expect(stepShape).toMatchInlineSnapshot(`
      [
        "pending/",
        "running/kuali-extraction",
        "skipped/kronos-search",
        "running/ucpath-job-summary",
        "running/ucpath-transaction",
        "running/kuali-finalization",
        "done/",
      ]
    `);

    const skippedRow = timeline.find((e) => e.step === "kronos-search");
    assert.ok(skippedRow, "a kronos-search row must exist");
    assert.equal(skippedRow.status, "skipped", "the bypassed step emits status=skipped");

    // The RUN itself completes — the latest queue row is Done, not Skipped.
    const finalSnap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId,
      workflowLabel: separationsWorkflow.config.label,
    });
    assert.equal(finalSnap.status, "done");
    assert.equal(finalSnap.statusLabel, "Done");
    assert.equal(finalSnap.archetype, "single");
    expect(finalSnap).toMatchInlineSnapshot(`
      {
        "archetype": "single",
        "data": {
          "__id": "DOC-1",
          "__name": "Jane Doe",
          "__subject": "Separation DOC-1",
          "__subjectKind": "document",
          "__traceId": "<traceId>",
          "archetype": "single",
          "docId": "DOC-1",
          "eid": "12345",
          "instance": "Separation 1",
          "name": "Jane Doe",
          "queueRowKind": "person",
          "transactionNumber": "T-999",
        },
        "displayId": "12345",
        "itemId": "DOC-1",
        "parentRunId": null,
        "rowTypeLabel": "Single",
        "runId": "sep-doc-1#run",
        "status": "done",
        "statusLabel": "Done",
        "step": undefined,
        "subtitle": "12345",
        "surfacePlacement": "flat",
        "surfaceType": "single",
        "title": "Jane Doe",
        "workflow": "separations",
      }
    `);
  });
});
