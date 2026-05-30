import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import {
  createScenarioRuntime,
  snapshotRow,
  type ScenarioBeat,
} from "../_runtime/index.js";
import { oathSignatureWorkflow } from "../../../src/workflows/oath-signature/workflow.js";

/**
 * Scenario: operator clicks Cancel while the `transaction` step is in flight.
 *
 * Realistic state transitions:
 *   pending → running(ocr) → running(ucpath-auth) → running(transaction) →
 *   [cancel injected] → running(transaction:failed:…) → running(cancelled) →
 *   failed(step: cancelled)
 *
 * Dashboard contract:
 *   - Pre-cancel snapshot: row is `running` with `step: transaction`, placed
 *     on the flat queue surface (oath-signature is `archetype: single`).
 *   - Post-cancel snapshot: row is `failed` with `step: cancelled` — this is
 *     what triggers the dashboard's amber "Cancelled" badge instead of the
 *     red "Failed" one (see `STATUS_CONFIG` in `EntryItem.tsx`).
 *
 * Snapshots use vitest's `toMatchInlineSnapshot`. On first run vitest fills
 * in the literal; on legitimate row-shape changes, regen with `vitest -u`
 * and review the diff. Hand-rolled `assert.equal` is used only for the
 * structural invariants (result.ok / kind) that should never change.
 */
describe("oath-signature scenario: cancel during transaction", () => {
  test("operator cancels while transaction is in flight", async (t) => {
    const beats: ScenarioBeat[] = [
      // Production oath-signature handler calls `ctx.updateData({...input})`
      // at the top before any step boundary, which seeds emplId/name onto
      // every subsequent `running` row.
      { kind: "updateData", data: { emplId: "10873698", name: "Jane Doe" } },
      // PDF-branch-only steps are skipped on a signer run; ucpath-auth is a
      // synthetic `markStep` marker (auth handled by Session.launch in
      // production). The real transaction step is held until cancel.
      { kind: "skipStep", name: "ocr" },
      { kind: "skipStep", name: "fan-out" },
      { kind: "markStep", name: "ucpath-auth" },
      { kind: "step", name: "transaction", hold: true },
    ];

    const rt = await createScenarioRuntime({
      workflow: oathSignatureWorkflow,
      beats,
    });
    t.onTestFinished(() => rt.cleanup());

    const { runId, result } = rt.enqueue({
      kind: "signer",
      emplId: "10873698",
      name: "Jane Doe",
    });

    // Wait for the transaction step to enter its held body — at this point
    // the kernel has already written the `running, step: transaction` row.
    await rt.waitForStepStart("transaction");
    const heldSnap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId,
      workflowLabel: oathSignatureWorkflow.config.label,
    });
    // Ignore volatile fields (timestamps, generated ids, instance counter)
    // when locking the snapshot — the contract is the *shape* the dashboard
    // renders, not the specific runId/instance number for this run.
    expect({
      ...heldSnap,
      runId: "<runId>",
      itemId: "<itemId>",
      data: { ...heldSnap.data, instance: "<instance>" },
    }).toMatchInlineSnapshot(`
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
        "rowTypeLabel": "Single",
        "runId": "<runId>",
        "status": "running",
        "statusLabel": "Running",
        "step": "transaction",
        "subtitle": "10873698",
        "surfacePlacement": "flat",
        "surfaceType": "single",
        "title": "Oath Signature EID 10873698",
        "workflow": "oath-signature",
      }
    `);

    // Inject cancel. The runtime flips `isCancelRequested` and rejects the
    // hold so the kernel's mapEscapedHandlerError remaps the throw into a
    // CancelledError and stamps `step: "cancelled"` on the terminal row.
    await rt.cancelRow(runId);
    await rt.waitForTerminal(runId);

    const cancelledSnap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId,
      workflowLabel: oathSignatureWorkflow.config.label,
    });
    expect({
      ...cancelledSnap,
      runId: "<runId>",
      itemId: "<itemId>",
      data: { ...cancelledSnap.data, instance: "<instance>" },
    }).toMatchInlineSnapshot(`
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
        "error": "Cancelled by user before step 'cancelled'",
        "itemId": "<itemId>",
        "parentRunId": null,
        "rowTypeLabel": "Single",
        "runId": "<runId>",
        "status": "failed",
        "statusLabel": "Cancelled",
        "step": "cancelled",
        "subtitle": "10873698",
        "surfacePlacement": "flat",
        "surfaceType": "single",
        "title": "Oath Signature EID 10873698",
        "workflow": "oath-signature",
      }
    `);

    const res = await result;
    assert.equal(res.ok, false);
    assert.equal(res.kind, "cancelled");

    // Explicit Contract invariant: cancel MUST NOT mutate the row's display
    // title. The two snapshots above already lock the literals, but a named
    // assertion makes the contract loud — a future change that starts
    // rewriting the title on cancel (e.g. stamping "Cancelled" into the
    // queue-title field) would fail here even if someone regenerated the
    // snapshots without noticing the diff.
    assert.equal(
      cancelledSnap.title,
      heldSnap.title,
      "cancel mutated the row title — Contract: cancel changes status only, never title",
    );
    assert.equal(cancelledSnap.subtitle, heldSnap.subtitle, "cancel mutated subtitle");
    assert.equal(cancelledSnap.archetype, heldSnap.archetype, "cancel mutated archetype");
  });
});
