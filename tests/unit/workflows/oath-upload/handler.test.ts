import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  oathUploadHandler,
  type OathUploadHandlerOpts,
} from "../../../../src/workflows/oath-upload/handler.js";
import type { ChildOutcome } from "../../../../src/tracker/delegation/watch-child-runs.js";

function makeFakeCtx() {
  const stepCalls: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const ctx = {
    runId: "oath-upload-run-1",
    trackerDir: undefined as string | undefined,
    signal: new AbortController().signal,
    data: {} as Record<string, unknown>,
    page: async () => ({ url: () => "x", title: async () => "x" }),
    step: async (name: string, fn: () => Promise<void>) => {
      stepCalls.push(name);
      await fn();
    },
    markStep: (name: string) => {
      stepCalls.push(`mark:${name}`);
    },
    skipStep: (name: string) => {
      stepCalls.push(`skip:${name}`);
    },
    updateData: (d: Record<string, unknown>) => {
      updates.push(d);
      Object.assign(ctx.data, d);
    },
    screenshot: async () => undefined,
  };
  return { ctx, stepCalls, updates };
}

const RESOLVE_PDF: NonNullable<OathUploadHandlerOpts["_resolvePdfOverride"]> = (input) => ({
  pdfPath: input.pdfPath ?? "/tmp/resolved.pdf",
  ...(input.pdfHash ? { pdfHash: input.pdfHash } : { pdfHash: "a".repeat(64) }),
});

function doneOutcome(itemId: string): ChildOutcome {
  return { workflow: "oath-signature", itemId, runId: `${itemId}-run`, status: "done" };
}

test("oathUploadHandler: waits on signers → servicenow-auth → open-hr-form → fill-form → submit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-handler-"));
  try {
    const { ctx, stepCalls, updates } = makeFakeCtx();
    let watchedWorkflow = "";
    let watchedItemIds: string[] = [];
    let fillFormCalled = false;
    let submitCalled = false;
    let gotoCalled = false;
    let verifyCalled = false;

    await oathUploadHandler(ctx as never, {
      pdfFileId: "file-1",
      pdfOriginalName: "test.pdf",
      sessionId: "session-1",
      mode: "full",
      rosterMode: "download",
      signerItemIds: ["ocr-oath-r0", "ocr-oath-r1", "ocr-oath-r2"],
    }, {
      trackerDir: dir,
      _resolvePdfOverride: RESOLVE_PDF,
      _watchChildRunsOverride: async (opts) => {
        watchedWorkflow = opts.workflow;
        watchedItemIds = opts.expectedItemIds;
        return opts.expectedItemIds.map(doneOutcome);
      },
      _loginOverride: async () => true,
      _gotoOverride: async () => { gotoCalled = true; },
      _verifyOverride: async () => { verifyCalled = true; },
      _fillFormOverride: async () => { fillFormCalled = true; },
      _submitOverride: async () => { submitCalled = true; return "HRC0123456"; },
    });

    assert.equal(watchedWorkflow, "oath-signature");
    assert.deepEqual(watchedItemIds, ["ocr-oath-r0", "ocr-oath-r1", "ocr-oath-r2"]);
    assert.ok(gotoCalled, "open-hr-form should call goto");
    assert.ok(verifyCalled, "open-hr-form should call verify");
    assert.ok(fillFormCalled, "fill-form should call the form-fill override");
    assert.ok(submitCalled, "submit should call the submit override");

    assert.ok(stepCalls.includes("wait-signatures"));
    assert.ok(!stepCalls.includes("delegate-signatures"));
    assert.ok(stepCalls.includes("servicenow-auth"));
    assert.ok(stepCalls.includes("open-hr-form"));
    assert.ok(stepCalls.includes("fill-form"));
    assert.ok(stepCalls.includes("submit"));

    assert.equal(updates.find((u) => u.signerCount)?.signerCount, "3");
    assert.equal(updates.find((u) => u.ticketNumber)?.ticketNumber, "HRC0123456");
    assert.ok(updates.some((u) => u.status === "waiting-signatures"));
    assert.ok(updates.some((u) => u.status === "filed"));
    assert.ok(updates.some((u) => typeof u.submittedAt === "string"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oathUploadHandler: a failed signer THROWS and does NOT file the ticket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-handler-fail-"));
  try {
    const { ctx, stepCalls } = makeFakeCtx();
    let submitCalled = false;

    await assert.rejects(
      oathUploadHandler(ctx as never, {
        pdfFileId: "file-1",
        pdfOriginalName: "test.pdf",
        sessionId: "session-fail",
        mode: "full",
        rosterMode: "download",
        signerItemIds: ["r0", "r1"],
      }, {
        trackerDir: dir,
        _resolvePdfOverride: RESOLVE_PDF,
        _watchChildRunsOverride: async () => [
          doneOutcome("r0"),
          { workflow: "oath-signature", itemId: "r1", runId: "r1-run", status: "failed", error: "UCPath blew up" },
        ],
        _loginOverride: async () => true,
        _submitOverride: async () => { submitCalled = true; return "HRC-SHOULD-NOT-HAPPEN"; },
      }),
      /did not succeed.*NOT filing/,
    );

    assert.equal(submitCalled, false, "ticket must not be filed when a signer failed");
    assert.ok(stepCalls.includes("wait-signatures"));
    assert.ok(!stepCalls.includes("submit"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oathUploadHandler: a MISSING signer outcome THROWS and does NOT file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-handler-missing-"));
  try {
    const { ctx } = makeFakeCtx();
    let submitCalled = false;
    await assert.rejects(
      oathUploadHandler(ctx as never, {
        pdfFileId: "file-1",
        pdfOriginalName: "test.pdf",
        sessionId: "session-missing",
        mode: "full",
        rosterMode: "download",
        signerItemIds: ["r0", "r1"],
      }, {
        trackerDir: dir,
        _resolvePdfOverride: RESOLVE_PDF,
        // Only r0 came back — r1 is missing.
        _watchChildRunsOverride: async () => [doneOutcome("r0")],
        _loginOverride: async () => true,
        _submitOverride: async () => { submitCalled = true; return "x"; },
      }),
      /missing.*NOT filing|did not succeed/,
    );
    assert.equal(submitCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oathUploadHandler: dryRun skips ServiceNow submit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-handler-dry-run-"));
  try {
    const { ctx, stepCalls, updates } = makeFakeCtx();
    let submitCalled = false;

    await oathUploadHandler(ctx as never, {
      pdfPath: "/tmp/dry.pdf",
      pdfOriginalName: "dry.pdf",
      sessionId: "session-dry",
      pdfHash: "a".repeat(64),
      mode: "full",
      rosterMode: "download",
      signerItemIds: ["r0"],
      dryRun: true,
    }, {
      trackerDir: dir,
      _resolvePdfOverride: RESOLVE_PDF,
      _watchChildRunsOverride: async (opts) => opts.expectedItemIds.map(doneOutcome),
      _loginOverride: async () => true,
      _gotoOverride: async () => undefined,
      _verifyOverride: async () => undefined,
      _fillFormOverride: async () => undefined,
      _submitOverride: async () => { submitCalled = true; return "HRC-SHOULD-NOT-HAPPEN"; },
    });

    assert.equal(submitCalled, false);
    assert.ok(stepCalls.includes("wait-signatures"));
    assert.ok(stepCalls.includes("submit"));
    assert.ok(updates.some((u) => u.status === "dry-run-complete"));
    assert.ok(updates.some((u) => u.ticketNumber === "DRY RUN - not submitted"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oathUploadHandler: upload-only mode skips the signature wait then submits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-handler-upload-only-"));
  try {
    const { ctx, stepCalls, updates } = makeFakeCtx();
    let watchCalled = false;
    let fillFormCalled = false;
    let submitCalled = false;

    await oathUploadHandler(ctx as never, {
      pdfPath: "/tmp/upload-only.pdf",
      pdfOriginalName: "upload-only.pdf",
      sessionId: "session-upload-only",
      pdfHash: "a".repeat(64),
      mode: "upload-only",
      rosterMode: "download",
    }, {
      trackerDir: dir,
      _resolvePdfOverride: RESOLVE_PDF,
      _watchChildRunsOverride: async () => {
        watchCalled = true;
        throw new Error("should not be called");
      },
      _loginOverride: async () => true,
      _gotoOverride: async () => undefined,
      _verifyOverride: async () => undefined,
      _fillFormOverride: async () => { fillFormCalled = true; },
      _submitOverride: async () => { submitCalled = true; return "HRC0099999"; },
    });

    assert.equal(watchCalled, false);
    assert.equal(fillFormCalled, true);
    assert.equal(submitCalled, true);
    assert.ok(stepCalls.includes("skip:wait-signatures"));
    assert.ok(!stepCalls.includes("delegate-signatures"));
    assert.ok(stepCalls.includes("open-hr-form"));
    assert.ok(stepCalls.includes("fill-form"));
    assert.ok(stepCalls.includes("submit"));
    assert.equal(updates.find((u) => u.ticketNumber)?.ticketNumber, "HRC0099999");
    assert.equal(updates.find((u) => u.uploadMode)?.uploadMode, "upload-only");
    assert.equal(updates.find((u) => u.signerCount)?.signerCount, "skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
