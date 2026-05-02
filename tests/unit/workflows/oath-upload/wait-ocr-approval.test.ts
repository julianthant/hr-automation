import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trackEvent } from "../../../../src/tracker/jsonl.js";
import { waitForOcrApproval } from "../../../../src/workflows/oath-upload/wait-ocr-approval.js";

test("waitForOcrApproval: returns { step: 'approved', fannedOutItemIds } when OCR row reaches step=approved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-wait-ocr-"));
  try {
    const sessionId = "ocr-test-A";
    const itemIds = ["ocr-oath-x-r0", "ocr-oath-x-r1"];

    // Schedule the approved entry to appear after watcher start.
    setTimeout(() => {
      trackEvent({
        workflow: "ocr",
        timestamp: new Date().toISOString(),
        id: sessionId,
        runId: "ocr-run-1",
        status: "done",
        step: "approved",
        data: { fannedOutItemIds: JSON.stringify(itemIds) },
      }, dir);
    }, 200);

    const r = await waitForOcrApproval({ sessionId, trackerDir: dir, timeoutMs: 30_000 });
    assert.equal(r.step, "approved");
    assert.deepEqual(r.fannedOutItemIds, itemIds);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForOcrApproval: throws with /discarded/ when OCR row reaches step=discarded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-wait-ocr-discard-"));
  try {
    const sessionId = "ocr-test-B";
    setTimeout(() => {
      trackEvent({
        workflow: "ocr",
        timestamp: new Date().toISOString(),
        id: sessionId,
        runId: "ocr-run-2",
        status: "failed",
        step: "discarded",
      }, dir);
    }, 200);

    await assert.rejects(
      () => waitForOcrApproval({ sessionId, trackerDir: dir, timeoutMs: 30_000 }),
      /discarded/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForOcrApproval: throws when fannedOutItemIds is missing on approved entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-wait-ocr-noids-"));
  try {
    const sessionId = "ocr-test-C";
    setTimeout(() => {
      trackEvent({
        workflow: "ocr",
        timestamp: new Date().toISOString(),
        id: sessionId,
        runId: "ocr-run-3",
        status: "done",
        step: "approved",
        // no data.fannedOutItemIds
      }, dir);
    }, 200);

    await assert.rejects(
      () => waitForOcrApproval({ sessionId, trackerDir: dir, timeoutMs: 30_000 }),
      /fannedOutItemIds/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
