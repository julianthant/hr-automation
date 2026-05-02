import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { oathUploadHandler } from "../../../../src/workflows/oath-upload/handler.js";
import { trackEvent } from "../../../../src/tracker/jsonl.js";

test("oathUploadHandler: walks delegate-ocr → wait-ocr-approval → wait-signatures → open-hr-form → fill-form → submit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-handler-"));
  try {
    const stepCalls: string[] = [];
    const updates: Record<string, unknown>[] = [];
    let runOcrCalled = false;
    let waitOcrCalled = false;
    let watchChildCalled = false;
    let fillFormCalled = false;
    let submitCalled = false;
    let gotoCalled = false;
    let verifyCalled = false;

    const fakeCtx = {
      runId: "oath-upload-run-1",
      data: {} as Record<string, unknown>,
      page: async () => ({ url: () => "x", title: async () => "x" }),
      step: async (name: string, fn: () => Promise<void>) => {
        stepCalls.push(name);
        await fn();
      },
      markStep: (name: string) => { stepCalls.push(`mark:${name}`); },
      skipStep: (name: string) => { stepCalls.push(`skip:${name}`); },
      updateData: (d: Record<string, unknown>) => {
        updates.push(d);
        Object.assign(fakeCtx.data, d);
      },
      screenshot: async () => undefined,
    };

    await oathUploadHandler(fakeCtx as never, {
      pdfPath: "/tmp/test.pdf",
      pdfOriginalName: "test.pdf",
      sessionId: "session-1",
      pdfHash: "a".repeat(64),
    }, {
      trackerDir: dir,
      _runOcrOverride: async () => { runOcrCalled = true; },
      _waitForOcrApprovalOverride: async () => {
        waitOcrCalled = true;
        return { step: "approved" as const, fannedOutItemIds: ["a", "b", "c"] };
      },
      _watchChildRunsOverride: async () => {
        watchChildCalled = true;
        return [];
      },
      _gotoOverride: async () => { gotoCalled = true; },
      _verifyOverride: async () => { verifyCalled = true; },
      _fillFormOverride: async () => { fillFormCalled = true; },
      _submitOverride: async () => { submitCalled = true; return "HRC0123456"; },
    });

    assert.ok(runOcrCalled, "delegate-ocr step should fire the OCR override");
    assert.ok(waitOcrCalled, "wait-ocr-approval should call the wait override");
    assert.ok(watchChildCalled, "wait-signatures should call the watchChildRuns override");
    assert.ok(gotoCalled, "open-hr-form should call goto");
    assert.ok(verifyCalled, "open-hr-form should call verify");
    assert.ok(fillFormCalled, "fill-form should call the form-fill override");
    assert.ok(submitCalled, "submit should call the submit override");

    assert.ok(stepCalls.includes("delegate-ocr"));
    assert.ok(stepCalls.includes("wait-ocr-approval"));
    assert.ok(stepCalls.includes("mark:delegate-signatures"));
    assert.ok(stepCalls.includes("wait-signatures"));
    assert.ok(stepCalls.includes("open-hr-form"));
    assert.ok(stepCalls.includes("fill-form"));
    assert.ok(stepCalls.includes("submit"));

    const ticket = updates.find((u) => u.ticketNumber);
    assert.equal(ticket?.ticketNumber, "HRC0123456");
    const signers = updates.find((u) => u.signerCount);
    assert.equal(signers?.signerCount, "3");
    const filed = updates.find((u) => u.status === "filed");
    assert.ok(filed, "expected an updateData call setting status: 'filed'");
    const submittedAtUpdate = updates.find((u) => typeof u.submittedAt === "string");
    assert.ok(submittedAtUpdate, "expected an updateData call setting submittedAt ISO string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oathUploadHandler: skips delegate-ocr + wait-ocr-approval when prior approved OCR entry exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-handler-restart-"));
  try {
    const stepCalls: string[] = [];
    const updates: Record<string, unknown>[] = [];

    // The handler computes ocrSessionId = `oath-upload-${ctx.runId}-ocr`.
    // For ctx.runId = "oath-upload-run-X", ocrSessionId = "oath-upload-oath-upload-run-X-ocr".
    const runId = "oath-upload-run-X";
    const ocrSessionId = `oath-upload-${runId}-ocr`;

    // Pre-write the OCR approved tracker entry with fannedOutItemIds.
    trackEvent({
      workflow: "ocr",
      timestamp: new Date().toISOString(),
      id: ocrSessionId,
      runId: "ocr-prior-run",
      status: "done",
      step: "approved",
      data: { fannedOutItemIds: JSON.stringify(["x", "y"]) },
    }, dir);

    let runOcrCalled = false;
    let waitOcrCalled = false;

    const fakeCtx = {
      runId,
      data: {} as Record<string, unknown>,
      page: async () => ({ url: () => "x", title: async () => "x" }),
      step: async (name: string, fn: () => Promise<void>) => {
        stepCalls.push(name);
        await fn();
      },
      markStep: (name: string) => { stepCalls.push(`mark:${name}`); },
      skipStep: (name: string) => { stepCalls.push(`skip:${name}`); },
      updateData: (d: Record<string, unknown>) => {
        updates.push(d);
        Object.assign(fakeCtx.data, d);
      },
      screenshot: async () => undefined,
    };

    await oathUploadHandler(fakeCtx as never, {
      pdfPath: "/tmp/x.pdf",
      pdfOriginalName: "x.pdf",
      sessionId: "session-X",
      pdfHash: "a".repeat(64),
    }, {
      trackerDir: dir,
      _runOcrOverride: async () => { runOcrCalled = true; },
      _waitForOcrApprovalOverride: async () => {
        waitOcrCalled = true;
        return { step: "approved" as const, fannedOutItemIds: [] };
      },
      _watchChildRunsOverride: async () => [],
      _gotoOverride: async () => undefined,
      _verifyOverride: async () => undefined,
      _fillFormOverride: async () => undefined,
      _submitOverride: async () => "HRC0000111",
    });

    assert.ok(!runOcrCalled, "delegate-ocr override should NOT have been called when a prior approved OCR exists");
    assert.ok(!waitOcrCalled, "wait-ocr-approval override should NOT have been called when a prior approved OCR exists");
    // Recovery should skip those two steps explicitly.
    assert.ok(stepCalls.includes("skip:delegate-ocr"), `expected skip:delegate-ocr in: ${stepCalls.join(",")}`);
    assert.ok(stepCalls.includes("skip:wait-ocr-approval"), `expected skip:wait-ocr-approval in: ${stepCalls.join(",")}`);
    // Downstream steps must still fire.
    assert.ok(stepCalls.includes("wait-signatures"), `expected wait-signatures in: ${stepCalls.join(",")}`);
    assert.ok(stepCalls.includes("submit"));
    // signerCount should reflect the prior approval's fannedOutItemIds (2 ids: "x", "y").
    const signers = updates.find((u) => u.signerCount);
    assert.equal(signers?.signerCount, "2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
