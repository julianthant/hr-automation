/**
 * Integration tests: oath-upload workflow — upload-only + idempotency branches.
 *
 * Extends the existing oath-upload-smoke.test.ts with two additional branches:
 *
 *   (a) upload-only mode: `mode:"upload-only"` → handler calls
 *       `ctx.skipStep("wait-signatures")` before auth. Assert the `skipped`
 *       status row is emitted for wait-signatures AND later steps still
 *       complete normally (servicenow-auth, open-hr-form, fill-form, submit).
 *
 *   (b) idempotency — prior ticket already exists: seed a prior done row that
 *       carries a filed ticket number for the same sessionId. The handler should
 *       detect it via `findPriorTicketForSession`, skip the servicenow-auth /
 *       open-hr-form / fill-form / submit steps (all via `ctx.skipStep`), and
 *       reuse the existing ticket number. Assert no new submit call is made and
 *       the ticket number on the done row matches the prior one.
 *
 * Both branches run through the REAL kernel (runOneItem, Stepper,
 * withTrackedWorkflow, JSONL emit, archetype stamping). Playwright and live
 * ServiceNow are bypassed via escape-hatch overrides.
 */
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { defineWorkflow, runOneItem } from "../../src/core/kernel/workflow.js";
import { Session } from "../../src/core/kernel/session.js";
import { readEntries, dateLocal, rowFilePath } from "../../src/tracker/jsonl.js";
import { emitTrackerRow } from "../../src/tracker/jsonl-io.js";
import { closeStateDbForTests } from "../../src/tracker/state/db.js";
import { oathUploadHandler, oathUploadSteps } from "../../src/workflows/oath-upload/handler.js";
import { OathUploadInputSchema } from "../../src/workflows/oath-upload/schema.js";

// ─── Shared session + workflow builder ────────────────────────────────────────

function makeSession() {
  const fakePage = {} as never;
  const fakeBrowsers = new Map([
    ["servicenow", { page: fakePage, browser: null, context: fakePage } as never],
  ]);
  const session = Session.forTesting({
    systems: [{ id: "servicenow", login: async () => {} }],
    browsers: fakeBrowsers,
    readyPromises: new Map([["servicenow", Promise.resolve()]]),
  });
  (session as unknown as { captureAll: () => Promise<unknown[]> }).captureAll = async () => [];
  return session;
}

function makeTestWorkflow(trackerDir: string) {
  return defineWorkflow({
    name: "oath-upload-ext-test",
    label: "Oath Upload Extended Test",
    archetype: "single",
    systems: [{ id: "servicenow", login: async () => {} }],
    authSteps: false,
    steps: oathUploadSteps,
    schema: OathUploadInputSchema,
    getName: (d) => d.pdfOriginalName ?? "",
    getId: (d) => d.sessionId ?? "",
    handler: async (ctx, input) => {
      await oathUploadHandler(ctx, input, {
        trackerDir,
        _resolvePdfOverride: (inp) => ({
          pdfPath: inp.pdfPath ?? "/tmp/test.pdf",
          pdfHash: inp.pdfHash ?? "a".repeat(64),
        }),
        _watchChildRunsOverride: async (opts) =>
          opts.expectedItemIds.map((itemId) => ({
            workflow: "oath-signature",
            itemId,
            runId: `${itemId}-run`,
            status: "done" as const,
          })),
        _loginOverride: async () => true,
        _gotoOverride: async () => {},
        _verifyOverride: async () => {},
        _fillFormOverride: async () => {},
        _submitOverride: async () => "HRC0099999",
      });
    },
  });
}

// ─── Branch (a): upload-only mode ─────────────────────────────────────────────

describe("oath-upload: upload-only mode (ctx.skipStep('wait-signatures'))", () => {
  test("skips wait-signatures step and emits skipped row, then completes full upload", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "oath-upload-only-"));
    t.onTestFinished(() => {
      closeStateDbForTests(dir);
      rmSync(dir, { recursive: true, force: true });
    });

    const wf = makeTestWorkflow(dir);
    const session = makeSession();

    const result = await runOneItem({
      wf,
      session,
      item: {
        pdfPath: "/tmp/upload-only.pdf",
        pdfOriginalName: "upload-only.pdf",
        sessionId: "upload-only-session-1",
        pdfHash: "b".repeat(64),
        mode: "upload-only" as const,
        rosterMode: "download" as const,
      },
      itemId: "upload-only-session-1",
      runId: "upload-only-run-1",
      trackerDir: dir,
      callerPreEmits: false,
    });

    assert.ok(result.ok, `upload-only run should succeed; got: ${JSON.stringify(result)}`);

    // ── JSONL assertions ──────────────────────────────────────────────────────
    const rows = readEntries("oath-upload-ext-test", dir);

    // Terminal done row must exist.
    const doneRow = rows.findLast((r) => r.status === "done");
    assert.ok(doneRow, "must have a done row");
    assert.equal(
      doneRow.data?.ticketNumber,
      "HRC0099999",
      "done row must carry the ticket number from the stub",
    );
    assert.equal(
      doneRow.data?.archetype,
      "single",
      "archetype must be single",
    );

    // The wait-signatures step must appear as skipped (not running or done).
    const skippedWaitRow = rows.find(
      (r) => r.status === "skipped" && r.step === "wait-signatures",
    );
    assert.ok(
      skippedWaitRow,
      `expected a skipped row with step=wait-signatures; rows: ${JSON.stringify(
        rows.map((r) => ({ status: r.status, step: r.step })),
      )}`,
    );

    // Later steps (submit) must still have run — upload-only skips only the wait.
    const submitRunningRow = rows.find(
      (r) => r.status === "running" && r.step === "submit",
    );
    assert.ok(
      submitRunningRow,
      "submit step must have run (upload-only only skips wait-signatures, not the upload itself)",
    );

    // No running row for wait-signatures (it was skipped, never ran).
    const waitRunningRow = rows.find(
      (r) => r.status === "running" && r.step === "wait-signatures",
    );
    assert.equal(
      waitRunningRow,
      undefined,
      "wait-signatures must NOT have a running row — it was skipped",
    );
  });
});

// ─── Branch (b): idempotency — prior ticket already exists ────────────────────

describe("oath-upload: idempotency — prior ticket reused, submit not re-done", () => {
  test("detects prior ticket via JSONL scan and skips submit, reusing existing ticket", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "oath-upload-idem-"));
    t.onTestFinished(() => {
      closeStateDbForTests(dir);
      rmSync(dir, { recursive: true, force: true });
    });

    const sessionId = "idem-session-1";
    const priorTicket = "HRC0011111";
    const pdfHash = "c".repeat(64);

    // ── Arrange: seed a prior "done" row with a valid filed ticket ────────────
    // `findPriorTicketForSession` scans JSONL for:
    //   e.id === sessionId && typeof e.data.ticketNumber === "string" && isFiledTicketNumber(...)
    // A ticket is considered "filed" if it matches /^HRC\d+/i (from isFiledTicketNumber).
    emitTrackerRow(
      {
        workflow: "oath-upload",   // must match the REAL workflow name read by handler
        timestamp: new Date().toISOString(),
        id: sessionId,
        runId: "prior-run-1",
        status: "done",
        data: {
          archetype: "single",
          sessionId,
          pdfHash,
          ticketNumber: priorTicket,
          uploadMode: "full",
        },
      },
      dir,
    );

    // ── Act: run the workflow with the same sessionId + pdfHash ───────────────
    let submitCallCount = 0;
    const wfWithIdempotency = defineWorkflow({
      name: "oath-upload-ext-test",   // same name so JSONL rows are in the same file
      label: "Oath Upload Extended Test",
      archetype: "single",
      systems: [{ id: "servicenow", login: async () => {} }],
      authSteps: false,
      steps: oathUploadSteps,
      schema: OathUploadInputSchema,
      getName: (d) => d.pdfOriginalName ?? "",
      getId: (d) => d.sessionId ?? "",
      handler: async (ctx, input) => {
        await oathUploadHandler(ctx, input, {
          trackerDir: dir,
          _resolvePdfOverride: (inp) => ({
            pdfPath: inp.pdfPath ?? "/tmp/test.pdf",
            pdfHash: inp.pdfHash ?? pdfHash,
          }),
          _loginOverride: async () => true,
          _gotoOverride: async () => {},
          _verifyOverride: async () => {},
          _fillFormOverride: async () => {},
          _submitOverride: async () => {
            submitCallCount++;
            return "HRC0022222"; // new ticket — must NOT be returned when idempotent
          },
        });
      },
    });

    const session = makeSession();
    const result = await runOneItem({
      wf: wfWithIdempotency,
      session,
      item: {
        pdfPath: "/tmp/idem.pdf",
        pdfOriginalName: "idem.pdf",
        sessionId,
        pdfHash,
        mode: "upload-only" as const, // upload-only so wait-signatures is skipped first
        rosterMode: "download" as const,
      },
      itemId: sessionId,
      runId: "retry-run-2",
      trackerDir: dir,
      callerPreEmits: false,
    });

    assert.ok(result.ok, `idempotent run should succeed; got: ${JSON.stringify(result)}`);

    // ── Assertions ────────────────────────────────────────────────────────────

    // Submit must NOT have been called — prior ticket detected before auth.
    assert.equal(
      submitCallCount,
      0,
      "submit override must NOT be called when a prior ticket exists",
    );

    // Done row must carry the PRIOR ticket number, not a new one.
    const rows = readEntries("oath-upload-ext-test", dir);
    const doneRow = rows.findLast((r) => r.status === "done");
    assert.ok(doneRow, "must have a done row for the retry run");
    assert.equal(
      doneRow.data?.ticketNumber,
      priorTicket,
      `done row must carry prior ticket ${priorTicket}, not a new submission`,
    );

    // servicenow-auth, open-hr-form, fill-form, submit must all appear as skipped.
    const skippedSteps = rows
      .filter((r) => r.status === "skipped")
      .map((r) => r.step);

    for (const step of ["servicenow-auth", "open-hr-form", "fill-form", "submit"]) {
      assert.ok(
        skippedSteps.includes(step),
        `step "${step}" must be skipped when prior ticket exists; skipped: ${JSON.stringify(skippedSteps)}`,
      );
    }
  });

  test("no prior ticket: all steps run normally and submit is called once", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "oath-upload-no-idem-"));
    t.onTestFinished(() => {
      closeStateDbForTests(dir);
      rmSync(dir, { recursive: true, force: true });
    });

    let submitCallCount = 0;
    const wf = defineWorkflow({
      name: "oath-upload-ext-test",
      label: "Oath Upload Extended Test",
      archetype: "single",
      systems: [{ id: "servicenow", login: async () => {} }],
      authSteps: false,
      steps: oathUploadSteps,
      schema: OathUploadInputSchema,
      getName: (d) => d.pdfOriginalName ?? "",
      getId: (d) => d.sessionId ?? "",
      handler: async (ctx, input) => {
        await oathUploadHandler(ctx, input, {
          trackerDir: dir,
          _resolvePdfOverride: (inp) => ({
            pdfPath: inp.pdfPath ?? "/tmp/test.pdf",
            pdfHash: inp.pdfHash ?? "d".repeat(64),
          }),
          _loginOverride: async () => true,
          _gotoOverride: async () => {},
          _verifyOverride: async () => {},
          _fillFormOverride: async () => {},
          _submitOverride: async () => {
            submitCallCount++;
            return "HRC0033333";
          },
        });
      },
    });

    const session = makeSession();
    const result = await runOneItem({
      wf,
      session,
      item: {
        pdfPath: "/tmp/fresh.pdf",
        pdfOriginalName: "fresh.pdf",
        sessionId: "fresh-session-99",
        pdfHash: "d".repeat(64),
        mode: "upload-only" as const,
        rosterMode: "download" as const,
      },
      itemId: "fresh-session-99",
      runId: "fresh-run-1",
      trackerDir: dir,
      callerPreEmits: false,
    });

    assert.ok(result.ok, `fresh run should succeed; got: ${JSON.stringify(result)}`);
    assert.equal(submitCallCount, 1, "submit must be called exactly once when no prior ticket exists");

    const rows = readEntries("oath-upload-ext-test", dir);
    const doneRow = rows.findLast((r) => r.status === "done");
    assert.ok(doneRow, "done row must exist");
    assert.equal(
      doneRow.data?.ticketNumber,
      "HRC0033333",
      "done row must carry the newly submitted ticket",
    );
  });
});

// ─── JSONL file path sanity check ─────────────────────────────────────────────

test("oath-upload-ext-test: JSONL file is created under the temp dir", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-ext-path-"));
  t.onTestFinished(() => {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  const wf = makeTestWorkflow(dir);
  const session = makeSession();

  await runOneItem({
    wf,
    session,
    item: {
      pdfPath: "/tmp/path-check.pdf",
      pdfOriginalName: "path-check.pdf",
      sessionId: "path-check-session",
      pdfHash: "e".repeat(64),
      mode: "upload-only" as const,
      rosterMode: "download" as const,
    },
    itemId: "path-check-session",
    runId: "path-check-run",
    trackerDir: dir,
    callerPreEmits: false,
  });

  const today = dateLocal();
  const expectedPath = rowFilePath("oath-upload-ext-test", today, dir);
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(expectedPath), `JSONL file must exist at ${expectedPath}`);
});
