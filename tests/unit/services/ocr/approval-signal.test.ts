import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  subscribeToApproval,
  emitApproved,
  emitDiscarded,
  OcrDiscardedError,
  OcrApprovalCancelledError,
  OcrApprovalFailedError,
  _resetApprovalSignalRegistryForTests,
} from "../../../../src/services/ocr/approval-signal.js";
import { rowFilePath, rowsDir } from "../../../../src/tracker/jsonl.js";

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

test("approval-signal: subscribers sharing a session are isolated by runId", async () => {
  _resetApprovalSignalRegistryForTests();
  const ctrlA = new AbortController();
  const ctrlB = new AbortController();
  const keyA = { workflow: "ocr", sessionId: "shared-session", runId: "run-a" };
  const keyB = { workflow: "ocr", sessionId: "shared-session", runId: "run-b" };
  const waitA = subscribeToApproval(keyA, { signal: ctrlA.signal, pollMs: 60_000, initialPollMs: 60_000 });
  const waitB = subscribeToApproval(keyB, { signal: ctrlB.signal, pollMs: 60_000, initialPollMs: 60_000 });
  emitApproved(keyB, { records: [{ run: "b" }] });
  assert.deepEqual(await waitB, { records: [{ run: "b" }] });
  ctrlA.abort();
  await assert.rejects(waitA, OcrApprovalCancelledError);
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
    // Production writes OCR rows under `.tracker/rows/` — the backstop reads
    // via `rowFilePath`, so the test must write to the same canonical location
    // (a flat `dir/ocr-<date>.jsonl` would silently never be read).
    mkdirSync(rowsDir(dir), { recursive: true });
    const path = rowFilePath("ocr", `${yyyy}-${mm}-${dd}`, dir);
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
    mkdirSync(rowsDir(dir), { recursive: true });
    const path = rowFilePath("ocr", `${yyyy}-${mm}-${dd}`, dir);
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

test("approval-signal: JSONL backstop rejects on hard OCR prep failure", async () => {
  _resetApprovalSignalRegistryForTests();
  const dir = mkdtempSync(join(tmpdir(), "ocr-approval-"));
  try {
    const key = { workflow: "ocr", sessionId: "session-jsonl-failed" };
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    mkdirSync(rowsDir(dir), { recursive: true });
    const path = rowFilePath("ocr", `${yyyy}-${mm}-${dd}`, dir);
    writeFileSync(path, JSON.stringify({
      workflow: "ocr",
      id: key.sessionId,
      runId: `${key.sessionId}#1`,
      timestamp: new Date().toISOString(),
      status: "failed",
      step: "ocr",
      error: "OCR provider exhausted",
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
        assert.ok(err instanceof OcrApprovalFailedError);
        assert.equal((err as OcrApprovalFailedError).reason, "OCR provider exhausted");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approval-signal: backstop reads rows/ — a stale flat-path row is NOT picked up", async () => {
  // Regression (2026-06-02): the backstop previously read a flat
  // `dir/ocr-<date>.jsonl`, which the tracker-dir restructure moved to
  // `dir/rows/`. A daemon-hosted OCR handler then never saw the dashboard's
  // approve and stalled at `step=ocr`. Pin that the backstop ignores the
  // legacy flat location: a flat-path approve row must NOT resolve the wait,
  // so an abort is the only way out.
  _resetApprovalSignalRegistryForTests();
  const dir = mkdtempSync(join(tmpdir(), "ocr-approval-"));
  try {
    const key = { workflow: "ocr", sessionId: "session-flat-ignored" };
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    // Write the approved row at the OLD flat location only.
    writeFileSync(join(dir, `ocr-${yyyy}-${mm}-${dd}.jsonl`), JSON.stringify({
      workflow: "ocr",
      id: key.sessionId,
      runId: `${key.sessionId}#1`,
      timestamp: new Date().toISOString(),
      status: "done",
      step: "approved",
      data: { records: JSON.stringify([{ x: 1 }]) },
    }) + "\n");

    const ctrl = new AbortController();
    const promise = subscribeToApproval(key, {
      signal: ctrl.signal,
      trackerDir: dir,
      initialPollMs: 5,
      pollMs: 5,
    });
    // Give the backstop several poll cycles; it must NOT resolve from the flat row.
    setTimeout(() => ctrl.abort(), 60);
    await assert.rejects(promise, (err: unknown) => err instanceof OcrApprovalCancelledError);
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
