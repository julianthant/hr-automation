import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { defineWorkflow, runOneItem } from "../../src/core/kernel/workflow.js";
import { Session } from "../../src/core/kernel/session.js";
import { dateLocal } from "../../src/tracker/jsonl.js";
import { oathUploadHandler, oathUploadSteps } from "../../src/workflows/oath-upload/handler.js";
import { OathUploadInputSchema } from "../../src/workflows/oath-upload/schema.js";

/**
 * Integration smoke test for the oath-upload workflow.
 *
 * Uses a thin test-only workflow wrapper that calls `oathUploadHandler` with
 * all escape-hatch opts, driven through the real kernel via `runOneItem` +
 * `Session.forTesting`. This exercises:
 *  - Real Stepper / ctx.step / ctx.updateData / ctx.skipStep flow
 *  - Real `withTrackedWorkflow` JSONL emit
 *  - Real archetype stamping (`delegating-batch` → `batch-parent`)
 *  - Real handler orchestration body (delegate-ocr → wait-ocr-approval →
 *    delegate-signatures → wait-signatures → open-hr-form → fill-form → submit)
 *
 * What it does NOT exercise (stubbed by escape hatches):
 *  - Playwright / real ServiceNow browser interaction
 *  - Live OCR / Gemini API calls
 *  - Daemon enqueue paths
 */
test(
  "oath-upload integration smoke — end-to-end workflow run via real kernel ctx",
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "oath-upload-smoke-"));
    t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

    // The workflow-level config.handler (`oathUploadWorkflow`) does not expose
    // escape hatches — it wraps `oathUploadHandler` without opts. We define a
    // thin test-only workflow whose handler calls `oathUploadHandler` directly
    // with all _-prefixed overrides, giving us a real kernel ctx while
    // bypassing Playwright and live service calls.
    //
    // `systems: [{ id: "servicenow", login: async () => {} }]` + a fake Page
    // slot in Session.forTesting lets `ctx.page("servicenow")` resolve to a
    // stub. The stub is never actually used because every page-consuming
    // function (_gotoOverride, _verifyOverride, _fillFormOverride,
    // _submitOverride) is overridden to a no-op / fake return.
    const testWorkflow = defineWorkflow({
      name: "oath-upload-smoke-test",
      label: "Oath Upload Smoke",
      archetype: "delegating-batch",
      systems: [
        {
          id: "servicenow",
          login: async () => {
            // No-op — Session.forTesting bypasses real auth
          },
        },
      ],
      authSteps: false,
      steps: oathUploadSteps,
      schema: OathUploadInputSchema,
      getName: (d) => d.pdfOriginalName ?? "",
      getId: (d) => d.sessionId ?? "",
      handler: async (ctx, input) => {
        ctx.markStep("servicenow-auth");
        await oathUploadHandler(ctx, input, {
          trackerDir: dir,
          _runOcrOverride: async () => {
            // Stub OCR dispatch — no real child workflow
          },
          _waitForOcrApprovalOverride: async () => ({
            step: "approved" as const,
            fannedOutItemIds: [],
          }),
          _watchChildRunsOverride: async () => [],
          _gotoOverride: async () => {},
          _verifyOverride: async () => {},
          _fillFormOverride: async () => {},
          _submitOverride: async () => "HRC0012345",
        });
      },
    });

    // Fake Playwright Page — never actually invoked because all page-consuming
    // handler functions are overridden. Cast as `never` to satisfy the private
    // SystemSlot type that Session.forTesting expects.
    const fakePage = {} as never;
    const fakeBrowsers = new Map([
      [
        "servicenow",
        { page: fakePage, browser: null, context: fakePage } as never,
      ],
    ]);

    const session = Session.forTesting({
      systems: testWorkflow.config.systems,
      browsers: fakeBrowsers,
      readyPromises: new Map([["servicenow", Promise.resolve()]]),
    });
    // Stub captureAll (called by tryScreenshot on step failure) to prevent
    // real Playwright calls — same pattern as createScenarioRuntime.
    (session as unknown as { captureAll: () => Promise<unknown[]> }).captureAll =
      async () => [];

    const runId = "oath-upload-smoke-run-1";
    const itemId = "smoke-session-1";

    const result = await runOneItem({
      wf: testWorkflow,
      session,
      item: {
        pdfPath: "/tmp/smoke-test.pdf",
        pdfOriginalName: "smoke-test.pdf",
        sessionId: itemId,
        pdfHash: "a".repeat(64),
        mode: "full" as const,
        rosterMode: "download" as const,
      },
      itemId,
      runId,
      trackerDir: dir,
      callerPreEmits: false,
    });

    assert.ok(result.ok, `runOneItem should succeed; got: ${JSON.stringify(result)}`);

    // Read the emitted JSONL and assert the final row shape.
    const today = dateLocal();
    const jsonlPath = join(dir, `oath-upload-smoke-test-${today}.jsonl`);
    const rows = readFileSync(jsonlPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    // Terminal "done" row must exist.
    const doneRow = rows.findLast(
      (r: { status: string }) => r.status === "done",
    );
    assert.ok(doneRow, `expected a done row in JSONL; rows: ${JSON.stringify(rows.map((r: { status: string; step?: string }) => ({ status: r.status, step: r.step })))}`);

    // The submit step must have been reached and the ticket number stored.
    assert.equal(
      doneRow.data?.ticketNumber,
      "HRC0012345",
      "data.ticketNumber should match the stub return value",
    );

    // Archetype stamping: root row should carry batch-parent (delegating-batch workflow).
    assert.equal(
      doneRow.data?.archetype,
      "batch-parent",
      "root oath-upload row should be stamped batch-parent",
    );

    // The submit step should appear as a running row with step=submit in the
    // JSONL sequence (withTrackedWorkflow emits a separate running row per
    // step; the terminal done row carries the workflow-level status without
    // a per-step field).
    const submitRunningRow = rows.find(
      (r: { status: string; step?: string }) =>
        r.status === "running" && r.step === "submit",
    );
    assert.ok(
      submitRunningRow,
      `expected a running row with step=submit; steps seen: ${JSON.stringify(rows.map((r: { status: string; step?: string }) => ({ status: r.status, step: r.step })))}`,
    );
  },
);
