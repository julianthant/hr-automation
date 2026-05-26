import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  subscribeToApproval,
  emitApproved,
  emitDiscarded,
  OcrDiscardedError,
  OcrApprovalCancelledError,
  _resetApprovalSignalRegistryForTests,
} from "../../../../src/services/ocr/approval-signal.js";

function freshKey() {
  return { workflow: "ocr", sessionId: `s-${Math.random().toString(36).slice(2, 10)}` };
}

test("approval-signal: emitApproved wakes a pending subscriber", async () => {
  _resetApprovalSignalRegistryForTests();
  const key = freshKey();
  const ctrl = new AbortController();
  const promise = subscribeToApproval(key, { signal: ctrl.signal, pollMs: 60_000, initialPollMs: 60_000 });
  setImmediate(() => emitApproved(key, { records: [{ a: 1 }] }));
  const payload = await promise;
  assert.deepEqual(payload.records, [{ a: 1 }]);
});

test("approval-signal: emitDiscarded rejects pending subscriber with OcrDiscardedError", async () => {
  _resetApprovalSignalRegistryForTests();
  const key = freshKey();
  const ctrl = new AbortController();
  const promise = subscribeToApproval(key, { signal: ctrl.signal, pollMs: 60_000, initialPollMs: 60_000 });
  setImmediate(() => emitDiscarded(key, "operator clicked discard"));
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof OcrDiscardedError);
    assert.equal((err as OcrDiscardedError).reason, "operator clicked discard");
    return true;
  });
});

test("approval-signal: abort signal rejects pending subscriber with OcrApprovalCancelledError", async () => {
  _resetApprovalSignalRegistryForTests();
  const key = freshKey();
  const ctrl = new AbortController();
  const promise = subscribeToApproval(key, { signal: ctrl.signal, pollMs: 60_000, initialPollMs: 60_000 });
  setImmediate(() => ctrl.abort());
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof OcrApprovalCancelledError);
    return true;
  });
});

test("approval-signal: pre-aborted signal rejects synchronously", async () => {
  _resetApprovalSignalRegistryForTests();
  const key = freshKey();
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    subscribeToApproval(key, { signal: ctrl.signal, pollMs: 60_000, initialPollMs: 60_000 }),
    (err: unknown) => err instanceof OcrApprovalCancelledError,
  );
});

test("approval-signal: JSONL backstop picks up out-of-process approve write", async () => {
  _resetApprovalSignalRegistryForTests();
  const dir = mkdtempSync(join(tmpdir(), "ocr-approval-"));
  try {
    const key = { workflow: "ocr", sessionId: "session-jsonl-1" };
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const path = join(dir, `ocr-${yyyy}-${mm}-${dd}.jsonl`);
    // Pre-write an approved row before subscribing — backstop's initial poll
    // should pick it up regardless of in-memory listeners.
    writeFileSync(path, JSON.stringify({
      workflow: "ocr",
      id: key.sessionId,
      runId: `${key.sessionId}#1`,
      timestamp: new Date().toISOString(),
      status: "done",
      step: "approved",
      data: { records: JSON.stringify([{ x: 1 }, { x: 2 }]) },
    }) + "\n");

    const ctrl = new AbortController();
    const payload = await subscribeToApproval(key, {
      signal: ctrl.signal,
      trackerDir: dir,
      initialPollMs: 5,
      pollMs: 60_000,
    });
    assert.deepEqual(payload.records, [{ x: 1 }, { x: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approval-signal: JSONL backstop picks up discarded row out-of-process", async () => {
  _resetApprovalSignalRegistryForTests();
  const dir = mkdtempSync(join(tmpdir(), "ocr-approval-"));
  try {
    const key = { workflow: "ocr", sessionId: "session-jsonl-2" };
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const path = join(dir, `ocr-${yyyy}-${mm}-${dd}.jsonl`);
    writeFileSync(path, JSON.stringify({
      workflow: "ocr",
      id: key.sessionId,
      runId: `${key.sessionId}#1`,
      timestamp: new Date().toISOString(),
      status: "failed",
      step: "discarded",
      error: "operator discarded",
    }) + "\n");

    const ctrl = new AbortController();
    await assert.rejects(
      subscribeToApproval(key, {
        signal: ctrl.signal,
        trackerDir: dir,
        initialPollMs: 5,
        pollMs: 60_000,
      }),
      (err: unknown) => {
        assert.ok(err instanceof OcrDiscardedError);
        assert.equal((err as OcrDiscardedError).reason, "operator discarded");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approval-signal: emitApproved with no subscriber is silent by default", () => {
  _resetApprovalSignalRegistryForTests();
  // Should NOT throw with default opts.
  emitApproved({ workflow: "ocr", sessionId: "no-listener" }, { records: [] });
  emitDiscarded({ workflow: "ocr", sessionId: "no-listener" }, "noop");
});

test("approval-signal: emitApproved with requireListener throws when none registered", () => {
  _resetApprovalSignalRegistryForTests();
  assert.throws(
    () => emitApproved({ workflow: "ocr", sessionId: "no-listener-2" }, { records: [] }, { requireListener: true }),
    /no subscriber registered/,
  );
  assert.throws(
    () => emitDiscarded({ workflow: "ocr", sessionId: "no-listener-2" }, "x", { requireListener: true }),
    /no subscriber registered/,
  );
});
