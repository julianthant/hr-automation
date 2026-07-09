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
import {
  OcrApprovalFailedError,
  OcrDiscardedError,
} from "../../../../src/services/ocr/approval-signal.js";

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

test("oathUploadHandler born-at-upload: wait-approval learns the signer set, then waits + files (option A)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-born-"));
  try {
    const { ctx, stepCalls, updates } = makeFakeCtx();
    let subscribedSession = "";
    let watchedItemIds: string[] = [];
    let submitCalled = false;

    await oathUploadHandler(ctx as never, {
      pdfFileId: "file-1",
      pdfOriginalName: "oaths.pdf",
      sessionId: "sess-op",
      mode: "full",
      // NO signerItemIds → born at upload, learns them at approval.
    }, {
      trackerDir: dir,
      _resolvePdfOverride: RESOLVE_PDF,
      _subscribeToApprovalOverride: async (opts) => {
        subscribedSession = opts.sessionId;
        return {
          records: [],
          fannedOutItemIds: ["ocr-oath-sess-op-r0", "ocr-oath-sess-op-r1"],
        };
      },
      _watchChildRunsOverride: async (opts) => {
        watchedItemIds = opts.expectedItemIds;
        return opts.expectedItemIds.map(doneOutcome);
      },
      _loginOverride: async () => true,
      _gotoOverride: async () => {},
      _verifyOverride: async () => {},
      _fillFormOverride: async () => {},
      _submitOverride: async () => { submitCalled = true; return "HRC0099999"; },
    });

    assert.equal(subscribedSession, "sess-op", "waits on its own OCR session for approval");
    assert.ok(stepCalls.includes("wait-approval"), "the leading wait-approval step ran");
    assert.deepEqual(
      watchedItemIds,
      ["ocr-oath-sess-op-r0", "ocr-oath-sess-op-r1"],
      "waits on exactly the signer set learned at approval",
    );
    assert.equal(updates.find((u) => u.signerCount)?.signerCount, "2");
    assert.ok(updates.some((u) => u.status === "awaiting-approval"));
    assert.ok(submitCalled, "files the ticket after approval + signatures");
    assert.equal(updates.find((u) => u.ticketNumber)?.ticketNumber, "HRC0099999");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oathUploadHandler born-at-upload: approval with zero signer rows THROWS and never files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-born-empty-"));
  try {
    const { ctx, stepCalls, updates } = makeFakeCtx();
    let watchCalled = false;
    let submitCalled = false;

    await assert.rejects(
      oathUploadHandler(ctx as never, {
        pdfFileId: "file-1",
        pdfOriginalName: "oaths.pdf",
        sessionId: "sess-empty",
        mode: "full",
      }, {
        trackerDir: dir,
        _resolvePdfOverride: RESOLVE_PDF,
        _subscribeToApprovalOverride: async () => ({
          records: [],
          fannedOutItemIds: [],
        }),
        _watchChildRunsOverride: async () => {
          watchCalled = true;
          throw new Error("must not wait on an empty signer set");
        },
        _loginOverride: async () => true,
        _submitOverride: async () => { submitCalled = true; return "HRC-NOPE"; },
      }),
      /zero signer row\(s\).*NOT filing/,
    );

    assert.equal(watchCalled, false, "empty approval should fail before wait-signatures");
    assert.equal(submitCalled, false, "no ticket when approval produced no signer rows");
    assert.ok(stepCalls.includes("wait-approval"));
    assert.ok(!stepCalls.includes("wait-signatures"));
    assert.ok(!stepCalls.includes("submit"));
    assert.ok(updates.some((u) => u.status === "approval-empty"));
    assert.equal([...updates].reverse().find((u) => u.signerCount !== undefined)?.signerCount, "0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ISS-007 (e2e run 20260622): an upstream OCR discard must terminalize the
// born-at-upload oath-upload ticket on the CANCEL surface (orange Cancelled),
// not red Failed. The handler used to throw a plain Error, so the kernel froze
// the terminal row at `step=wait-approval` (red). It now throws a kernel
// `CancelledError("discarded")` → `kind:"cancelled"` + a `discarded` sentinel
// step that `statusKeyForEntry` classifies as Cancelled.
test("oathUploadHandler born-at-upload: a discarded OCR prep throws a CancelledError(discarded) and never files the ticket (ISS-007)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-born-discard-"));
  try {
    const { ctx, stepCalls } = makeFakeCtx();
    let submitCalled = false;
    const { CancelledError } = await import("../../../../src/core/kernel/types.js");

    let thrown: unknown;
    try {
      await oathUploadHandler(ctx as never, {
        pdfFileId: "file-1",
        pdfOriginalName: "oaths.pdf",
        sessionId: "sess-discard",
        mode: "full",
      }, {
        trackerDir: dir,
        _resolvePdfOverride: RESOLVE_PDF,
        _subscribeToApprovalOverride: async () => {
          throw new OcrDiscardedError("operator discarded");
        },
        _watchChildRunsOverride: async () => {
          throw new Error("must not wait on signers after a discard");
        },
        _loginOverride: async () => true,
        _submitOverride: async () => { submitCalled = true; return "HRC-NOPE"; },
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof CancelledError, "discard surfaces a kernel CancelledError (Cancel surface)");
    assert.equal(
      (thrown as InstanceType<typeof CancelledError>).stepName,
      "discarded",
      "the CancelledError carries the `discarded` sentinel step → orange Cancelled, not red Failed",
    );
    assert.equal(submitCalled, false, "no ticket on discard");
    assert.ok(stepCalls.includes("wait-approval"));
    assert.ok(!stepCalls.includes("wait-signatures"));
    assert.ok(!stepCalls.includes("submit"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oathUploadHandler born-at-upload: a hard OCR failure THROWS and never files the ticket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-born-ocr-failed-"));
  try {
    const { ctx, stepCalls } = makeFakeCtx();
    let submitCalled = false;

    await assert.rejects(
      oathUploadHandler(ctx as never, {
        pdfFileId: "file-1",
        pdfOriginalName: "oaths.pdf",
        sessionId: "sess-ocr-failed",
        mode: "full",
      }, {
        trackerDir: dir,
        _resolvePdfOverride: RESOLVE_PDF,
        _subscribeToApprovalOverride: async () => {
          throw new OcrApprovalFailedError("OCR provider exhausted");
        },
        _watchChildRunsOverride: async () => {
          throw new Error("must not wait on signers after OCR failure");
        },
        _loginOverride: async () => true,
        _submitOverride: async () => { submitCalled = true; return "HRC-NOPE"; },
      }),
      /OCR prep failed.*NOT filing.*OCR provider exhausted/,
    );

    assert.equal(submitCalled, false, "no ticket on OCR failure");
    assert.ok(stepCalls.includes("wait-approval"));
    assert.ok(!stepCalls.includes("wait-signatures"));
    assert.ok(!stepCalls.includes("submit"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 2026-07-09 walk hardening: ticket idempotency window + wait-signatures
//     poll-failure distinguishability ───────────────────────────────────────

import { mkdirSync, writeFileSync } from "node:fs";
import { rowFilePath, rowsDir, dateLocal } from "../../../../src/tracker/jsonl.js";
import { CancelledError } from "../../../../src/core/kernel/types.js";

function seedOathUploadRow(dir: string, row: object): void {
  mkdirSync(rowsDir(dir), { recursive: true });
  writeFileSync(rowFilePath("oath-upload", dateLocal(), dir), JSON.stringify(row) + "\n");
}

test("oathUploadHandler: wait-signatures REJECTION (poll error/timeout) throws a DISTINCT 'could not verify' error and never files (not conflated with a failed signer)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-watchfail-"));
  try {
    const { ctx } = makeFakeCtx();
    let submitCalled = false;

    await assert.rejects(
      oathUploadHandler(ctx as never, {
        pdfFileId: "file-1",
        pdfOriginalName: "test.pdf",
        sessionId: "session-watchfail",
        mode: "full",
        signerItemIds: ["r0", "r1"],
      }, {
        trackerDir: dir,
        _resolvePdfOverride: RESOLVE_PDF,
        _watchChildRunsOverride: async () => {
          throw new Error("watchChildRuns timeout (60000ms) — still waiting for: r1");
        },
        _loginOverride: async () => true,
        _submitOverride: async () => { submitCalled = true; return "HRC-SHOULD-NOT-HAPPEN"; },
      }),
      /could not verify the 2 oath-signature signer row\(s\).*wait-signatures failed.*NOT filing/,
    );

    assert.equal(submitCalled, false, "a poll failure must never be treated as 'signers verified'");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oathUploadHandler: a CancelledError from the signature wait propagates AS a cancel, not a wrapped failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-watchcancel-"));
  try {
    const { ctx } = makeFakeCtx();
    let submitCalled = false;

    await assert.rejects(
      oathUploadHandler(ctx as never, {
        pdfFileId: "file-1",
        pdfOriginalName: "test.pdf",
        sessionId: "session-watchcancel",
        mode: "full",
        signerItemIds: ["r0"],
      }, {
        trackerDir: dir,
        _resolvePdfOverride: RESOLVE_PDF,
        _watchChildRunsOverride: async () => { throw new CancelledError("cancelled"); },
        _loginOverride: async () => true,
        _submitOverride: async () => { submitCalled = true; return "x"; },
      }),
      (err: unknown) => err instanceof CancelledError,
    );
    assert.equal(submitCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oathUploadHandler: a prior attempt that reached submit WITHOUT a recorded ticket THROWS on retry — a ticket MAY exist; never auto-refile (idempotency window)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-unverified-"));
  try {
    // The prior attempt's `running step=submit` row durably carried the
    // pre-submit marker, then the run crashed before any ticketNumber landed.
    seedOathUploadRow(dir, {
      workflow: "oath-upload",
      id: "session-crashed",
      runId: "old-run",
      timestamp: new Date().toISOString(),
      status: "running",
      step: "submit",
      data: { submitAttempted: "true", pdfHash: "a".repeat(64) },
    });

    const { ctx, stepCalls, updates } = makeFakeCtx();
    let submitCalled = false;

    await assert.rejects(
      oathUploadHandler(ctx as never, {
        pdfFileId: "file-1",
        pdfOriginalName: "test.pdf",
        sessionId: "session-crashed",
        mode: "full",
        signerItemIds: ["r0"],
      }, {
        trackerDir: dir,
        _resolvePdfOverride: RESOLVE_PDF,
        _watchChildRunsOverride: async (opts) => opts.expectedItemIds.map(doneOutcome),
        _loginOverride: async () => true,
        _submitOverride: async () => { submitCalled = true; return "HRC-DUPLICATE"; },
      }),
      /MAY already have been filed.*Refusing to auto-submit again/,
    );

    assert.equal(submitCalled, false, "retry must not blindly re-file — the prior submit outcome is unknown");
    assert.ok(!stepCalls.includes("submit"), "the submit step is never reached");
    assert.ok(updates.some((u) => u.status === "submit-unverified"), "the row surfaces the unverified-submit state");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oathUploadHandler: a prior RECORDED ticket takes precedence over the unverified-submit guard — retry skips and reuses the ticket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-recorded-"));
  try {
    // Prior run reached submit AND recorded the ticket: marker + ticketNumber
    // both on disk. The probe must return the ticket (skip path), never the
    // unverified-submit throw.
    seedOathUploadRow(dir, {
      workflow: "oath-upload",
      id: "session-filed",
      runId: "old-run",
      timestamp: new Date().toISOString(),
      status: "done",
      step: "submit",
      data: { submitAttempted: "true", ticketNumber: "HRC0555555", pdfHash: "a".repeat(64) },
    });

    const { ctx, stepCalls, updates } = makeFakeCtx();
    let submitCalled = false;

    await oathUploadHandler(ctx as never, {
      pdfFileId: "file-1",
      pdfOriginalName: "test.pdf",
      sessionId: "session-filed",
      mode: "full",
      signerItemIds: ["r0"],
    }, {
      trackerDir: dir,
      _resolvePdfOverride: RESOLVE_PDF,
      _watchChildRunsOverride: async (opts) => opts.expectedItemIds.map(doneOutcome),
      _loginOverride: async () => true,
      _submitOverride: async () => { submitCalled = true; return "x"; },
    });

    assert.equal(submitCalled, false, "no second ServiceNow submit");
    assert.equal(updates.find((u) => u.ticketNumber)?.ticketNumber, "HRC0555555");
    assert.ok(stepCalls.includes("skip:submit"), "submit is skipped, not run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oathUploadHandler: the pre-submit marker is stamped BEFORE the submit step on a real run, and never for a dry run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-marker-"));
  try {
    // Unified event sequence so marker-vs-step ORDER is assertable.
    const events: string[] = [];
    const data: Record<string, unknown> = {};
    const ctx = {
      runId: "run-marker",
      trackerDir: undefined as string | undefined,
      signal: new AbortController().signal,
      data,
      page: async () => ({}),
      step: async (name: string, fn: () => Promise<void>) => { events.push(`step:${name}`); await fn(); },
      markStep: (name: string) => events.push(`mark:${name}`),
      skipStep: (name: string) => events.push(`skip:${name}`),
      updateData: (d: Record<string, unknown>) => {
        if (d.submitAttempted === "true") events.push("data:submitAttempted");
        Object.assign(data, d);
      },
      screenshot: async () => undefined,
    };

    await oathUploadHandler(ctx as never, {
      pdfFileId: "file-1",
      pdfOriginalName: "test.pdf",
      sessionId: "session-marker",
      mode: "full",
      signerItemIds: ["r0"],
    }, {
      trackerDir: dir,
      _resolvePdfOverride: RESOLVE_PDF,
      _watchChildRunsOverride: async (opts) => opts.expectedItemIds.map(doneOutcome),
      _loginOverride: async () => true,
      _gotoOverride: async () => {},
      _verifyOverride: async () => {},
      _fillFormOverride: async () => {},
      _submitOverride: async () => "HRC0123456",
    });

    const markerIdx = events.indexOf("data:submitAttempted");
    const submitIdx = events.indexOf("step:submit");
    assert.ok(markerIdx !== -1, "real run stamps the pre-submit marker");
    assert.ok(submitIdx !== -1);
    assert.ok(
      markerIdx < submitIdx,
      `marker must precede the submit step so the step-start row persists it before the ServiceNow POST (events: ${events.join(" → ")})`,
    );

    // Dry run: never stamps the marker (a dry run files nothing, so it must
    // not arm the unverified-submit guard for later real runs).
    const { ctx: dryCtx, updates: dryUpdates } = makeFakeCtx();
    await oathUploadHandler(dryCtx as never, {
      pdfFileId: "file-1",
      pdfOriginalName: "test.pdf",
      sessionId: "session-marker-dry",
      mode: "full",
      signerItemIds: ["r0"],
      dryRun: true,
    }, {
      trackerDir: dir,
      _resolvePdfOverride: RESOLVE_PDF,
      _watchChildRunsOverride: async (opts) => opts.expectedItemIds.map(doneOutcome),
      _loginOverride: async () => true,
      _gotoOverride: async () => {},
      _verifyOverride: async () => {},
      _fillFormOverride: async () => {},
      _submitOverride: async () => "HRC-SHOULD-NOT-HAPPEN",
    });
    assert.ok(
      !dryUpdates.some((u) => u.submitAttempted === "true"),
      "dry run never stamps submitAttempted",
    );
    assert.equal(dryUpdates.find((u) => u.ticketNumber)?.ticketNumber, "DRY RUN - not submitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oathUploadHandler: a DRY run proceeds even when a prior unverified-submit marker exists (dry runs file nothing)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-dry-after-crash-"));
  try {
    seedOathUploadRow(dir, {
      workflow: "oath-upload",
      id: "session-dry-after-crash",
      runId: "old-run",
      timestamp: new Date().toISOString(),
      status: "running",
      step: "submit",
      data: { submitAttempted: "true", pdfHash: "a".repeat(64) },
    });

    const { ctx, updates } = makeFakeCtx();
    await oathUploadHandler(ctx as never, {
      pdfFileId: "file-1",
      pdfOriginalName: "test.pdf",
      sessionId: "session-dry-after-crash",
      mode: "full",
      signerItemIds: ["r0"],
      dryRun: true,
    }, {
      trackerDir: dir,
      _resolvePdfOverride: RESOLVE_PDF,
      _watchChildRunsOverride: async (opts) => opts.expectedItemIds.map(doneOutcome),
      _loginOverride: async () => true,
      _gotoOverride: async () => {},
      _verifyOverride: async () => {},
      _fillFormOverride: async () => {},
      _submitOverride: async () => "HRC-SHOULD-NOT-HAPPEN",
    });
    assert.equal(updates.find((u) => u.ticketNumber)?.ticketNumber, "DRY RUN - not submitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
