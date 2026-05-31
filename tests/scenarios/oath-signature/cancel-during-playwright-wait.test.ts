import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";

import {
  createScenarioRuntime,
  snapshotRow,
  type ScenarioBeat,
} from "../_runtime/index.js";
import { oathSignatureWorkflow } from "../../../src/workflows/oath-signature/workflow.js";

/**
 * Contract 5: cancel propagates into a long AbortSignal-aware wait within
 * ms, NOT after the wait's declared timeout. In production this is what the
 * Page proxy gives us — `page.waitForSelector("foo", { timeout: 30000 })`
 * auto-receives `ctx.signal`, so an operator cancel aborts the wait
 * immediately rather than blocking the daemon for up to 30s.
 *
 * The scenario beat for this test simulates that exact code path: a 30s
 * `setTimeout` that rejects synchronously when `ctx.signal.aborted` flips.
 * We then assert:
 *   1. Cancel-to-terminal latency is well under the simulated wait timeout.
 *   2. The terminal row carries the same shape as a cooperative cancel
 *      (status: failed, step: cancelled) — the dashboard sees no difference
 *      between mid-wait and between-step cancel.
 */
describe("oath-signature scenario: cancel during a Playwright-style wait", () => {
  test("AbortSignal in ctx aborts an in-flight long wait within ~100ms", async (t) => {
    const SIM_WAIT_MS = 30_000;
    const beats: ScenarioBeat[] = [
      { kind: "updateData", data: { emplId: "10873698", name: "Jane Doe" } },
      { kind: "skipStep", name: "ocr" },
      { kind: "skipStep", name: "fan-out" },
      { kind: "markStep", name: "ucpath-auth" },
      // Long-wait beat (simulates page.waitForSelector with a 30s timeout
      // that observes the per-run AbortSignal). Cancel must interrupt this.
      {
        kind: "step",
        name: "transaction",
        signalWaitMs: SIM_WAIT_MS,
      },
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

    // Wait for the transaction step to actually start (its `running` row
    // is on disk and the simulated wait is now blocking inside the body).
    await rt.waitForStepStart("transaction");

    const cancelStart = Date.now();
    await rt.cancelRow(runId);
    await rt.waitForTerminal(runId, 5_000);
    const cancelLatency = Date.now() - cancelStart;

    // Contract 5 promises ms-class abort; 300ms catches regression to the
    // pre-Contract-5 between-step probe budget.
    assert.ok(
      cancelLatency < 300,
      `cancel should complete fast via AbortSignal — took ${cancelLatency}ms (sim wait was ${SIM_WAIT_MS}ms)`,
    );

    const res = await result;
    assert.equal(res.ok, false);
    assert.equal(res.kind, "cancelled");

    // Terminal row shape matches the existing cooperative-cancel snapshot
    // (cancel-during-transaction.test.ts) — Contract: cancel is one
    // mechanism, dashboard sees one shape.
    const snap = snapshotRow({
      trackerDir: rt.trackerDir,
      workflow: rt.workflow,
      runId,
      workflowLabel: oathSignatureWorkflow.config.label,
    });
    expect({
      ...snap,
      runId: "<runId>",
      itemId: "<itemId>",
      data: { ...snap.data, instance: "<instance>" },
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
  });
});
