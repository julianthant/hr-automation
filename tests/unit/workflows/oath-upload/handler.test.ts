import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  oathUploadHandler,
  type OathUploadHandlerOpts,
} from "../../../../src/workflows/oath-upload/handler.js";

function makeFakeCtx() {
  const stepCalls: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const ctx = {
    runId: "oath-upload-run-1",
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

test("oathUploadHandler: walks delegate-signatures → open-hr-form → fill-form → submit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-handler-"));
  try {
    const { ctx, stepCalls, updates } = makeFakeCtx();
    let delegateWorkflow = "";
    let delegateInput: unknown;
    let delegateOpts: unknown;
    let fillFormCalled = false;
    let submitCalled = false;
    let gotoCalled = false;
    let verifyCalled = false;

    const delegateOverride: NonNullable<OathUploadHandlerOpts["_delegateToOverride"]> =
      async (child, input, opts) => {
        delegateWorkflow = child.config.name;
        delegateInput = input;
        delegateOpts = opts;
        return {
          workflow: child.config.name,
          runId: "sig-run",
          itemId: "session-1",
          status: "done" as const,
          data: { fannedOutCount: "3" },
        };
      };

    await oathUploadHandler(ctx as never, {
      pdfPath: "/tmp/test.pdf",
      pdfOriginalName: "test.pdf",
      pdfFileId: "file-1",
      sessionId: "session-1",
      pdfHash: "a".repeat(64),
      mode: "full",
      rosterMode: "existing",
      rosterPath: "/tmp/roster.csv",
    }, {
      trackerDir: dir,
      _delegateToOverride: delegateOverride,
      _loginOverride: async () => true,
      _gotoOverride: async () => {
        gotoCalled = true;
      },
      _verifyOverride: async () => {
        verifyCalled = true;
      },
      _fillFormOverride: async () => {
        fillFormCalled = true;
      },
      _submitOverride: async () => {
        submitCalled = true;
        return "HRC0123456";
      },
    });

    assert.equal(delegateWorkflow, "oath-signature");
    assert.deepEqual(delegateInput, {
      kind: "pdf",
      pdfPath: "/tmp/test.pdf",
      pdfOriginalName: "test.pdf",
      pdfFileId: "file-1",
      sessionId: "session-1",
      pdfHash: "a".repeat(64),
      rosterMode: "existing",
      rosterPath: "/tmp/roster.csv",
    });
    assert.deepEqual(delegateOpts, { itemId: "session-1" });
    assert.ok(gotoCalled, "open-hr-form should call goto");
    assert.ok(verifyCalled, "open-hr-form should call verify");
    assert.ok(fillFormCalled, "fill-form should call the form-fill override");
    assert.ok(submitCalled, "submit should call the submit override");

    assert.ok(stepCalls.includes("delegate-signatures"));
    assert.ok(!stepCalls.includes("dispatch"));
    assert.ok(!stepCalls.includes("wait-signatures"));
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

test("oathUploadHandler: dryRun propagates to delegated PDF run and skips ServiceNow submit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-handler-dry-run-"));
  try {
    const { ctx, stepCalls, updates } = makeFakeCtx();
    let delegateInput: unknown;
    let submitCalled = false;

    const delegateOverride: NonNullable<OathUploadHandlerOpts["_delegateToOverride"]> =
      async (child, input) => {
        delegateInput = input;
        return {
          workflow: child.config.name,
          runId: "sig-run-dry",
          itemId: "session-dry",
          status: "done" as const,
          data: { fannedOutCount: "1" },
        };
      };

    await oathUploadHandler(ctx as never, {
      pdfPath: "/tmp/dry.pdf",
      pdfOriginalName: "dry.pdf",
      sessionId: "session-dry",
      pdfHash: "a".repeat(64),
      mode: "full",
      rosterMode: "download",
      dryRun: true,
    }, {
      trackerDir: dir,
      _delegateToOverride: delegateOverride,
      _loginOverride: async () => true,
      _gotoOverride: async () => undefined,
      _verifyOverride: async () => undefined,
      _fillFormOverride: async () => undefined,
      _submitOverride: async () => {
        submitCalled = true;
        return "HRC-SHOULD-NOT-HAPPEN";
      },
    });

    assert.deepEqual(delegateInput, {
      kind: "pdf",
      pdfPath: "/tmp/dry.pdf",
      pdfOriginalName: "dry.pdf",
      sessionId: "session-dry",
      pdfHash: "a".repeat(64),
      rosterMode: "download",
      dryRun: true,
    });
    assert.equal(submitCalled, false);
    assert.ok(stepCalls.includes("delegate-signatures"));
    assert.ok(stepCalls.includes("submit"));
    assert.ok(updates.some((u) => u.status === "dry-run-complete"));
    assert.ok(updates.some((u) => u.ticketNumber === "DRY RUN - not submitted"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oathUploadHandler: upload-only mode skips signature delegation then submits ServiceNow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-handler-upload-only-"));
  try {
    const { ctx, stepCalls, updates } = makeFakeCtx();
    let delegateCalled = false;
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
      _delegateToOverride: async () => {
        delegateCalled = true;
        throw new Error("should not be called");
      },
      _loginOverride: async () => true,
      _gotoOverride: async () => undefined,
      _verifyOverride: async () => undefined,
      _fillFormOverride: async () => {
        fillFormCalled = true;
      },
      _submitOverride: async () => {
        submitCalled = true;
        return "HRC0099999";
      },
    });

    assert.equal(delegateCalled, false);
    assert.equal(fillFormCalled, true);
    assert.equal(submitCalled, true);
    assert.ok(stepCalls.includes("skip:delegate-signatures"));
    assert.ok(!stepCalls.includes("dispatch"));
    assert.ok(!stepCalls.includes("wait-signatures"));
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
