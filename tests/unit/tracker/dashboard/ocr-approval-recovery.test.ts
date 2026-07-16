import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";

import { openControlDb } from "../../../../src/core/control-db.js";
import {
  buildOcrApproveHandler,
  resumeRecoverableOcrApprovals,
} from "../../../../src/tracker/dashboard/ocr/approve.js";
import { rowsDir } from "../../../../src/tracker/paths.js";
import {
  beginOcrApproval,
  hashOcrApprovalRequest,
  type OcrApprovalManifest,
} from "../../../../src/tracker/state/ocr-approval-store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("startup recovery dispatches the persisted manifest without OCR JSONL and approves exactly once", async () => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ocr-approval-recovery-"));
  dirs.push(trackerDir);
  const store = openControlDb({ trackerDir });
  const manifest: OcrApprovalManifest = {
    version: 1,
    id: "manifest-recovery",
    sessionId: "session-recovery",
    runId: "ocr-run-recovery",
    formType: "oath",
    parentRunId: "display-operation-parent",
    operationWorkflow: "oath-signature",
    records: [{ selected: true, employeeId: "10000001" }],
    reviewData: { pdfOriginalName: "recovery.pdf" },
    children: [
      {
        kind: "record",
        workflow: "oath-signature",
        itemId: "stable-signer-id-a",
        runId: "stable-signer-run-a",
        input: { emplId: "10000001", dryRun: true },
      },
      {
        kind: "record",
        workflow: "oath-signature",
        itemId: "stable-signer-id-b",
        runId: "stable-signer-run-b",
        input: { emplId: "10000001", dryRun: true },
      },
    ],
  };
  const requestHash = hashOcrApprovalRequest({ records: manifest.records });
  const claim = beginOcrApproval(store, {
    sessionId: manifest.sessionId,
    runId: manifest.runId,
    requestHash,
    manifest,
    ownerToken: "crashed-owner",
    allowAwaitingClaim: true,
    nowMs: 1_000,
    leaseMs: 10,
  });
  assert.equal(claim.kind, "claimed");

  // Simulate losing every JSONL projection before the dashboard restarts.
  rmSync(rowsDir(trackerDir), { recursive: true, force: true });
  const dispatched: Array<{ workflow: string; itemId: string; runId: string; input: unknown }> = [];
  const enqueueOverride = (
    workflow: string,
    inputs: unknown[],
    deriveItemId: (input: unknown, index: number) => string,
    opts?: { runIds?: string[] },
  ) => {
    inputs.forEach((input, index) => {
      dispatched.push({
        workflow,
        itemId: deriveItemId(input, index),
        runId: opts?.runIds?.[index] ?? "missing-run",
        input,
      });
    });
    return Promise.resolve({
      enqueued: inputs.map((input, index) => ({
        id: deriveItemId(input, index),
        runId: opts?.runIds?.[index],
      })),
    });
  };

  assert.equal(await resumeRecoverableOcrApprovals(trackerDir, {
    nowMs: 1_011,
    ensureDaemonsAndEnqueueOverride: enqueueOverride,
  }), 1);
  assert.deepEqual(dispatched, [
    {
      workflow: "oath-signature",
      itemId: "stable-signer-id-a",
      runId: "stable-signer-run-a",
      input: { emplId: "10000001", dryRun: true },
    },
    {
      workflow: "oath-signature",
      itemId: "stable-signer-id-b",
      runId: "stable-signer-run-b",
      input: { emplId: "10000001", dryRun: true },
    },
  ]);
  const durable = store.db.prepare(`
    SELECT state, presented_at FROM ocr_approvals WHERE session_id = ? AND run_id = ?
  `).get(manifest.sessionId, manifest.runId) as { state: string; presented_at: string | null };
  assert.equal(durable.state, "approved");
  assert.ok(durable.presented_at, "successful terminal projection must be checkpointed");

  assert.equal(await resumeRecoverableOcrApprovals(trackerDir, {
    nowMs: 50_000,
    ensureDaemonsAndEnqueueOverride: enqueueOverride,
  }), 0);
  assert.equal(dispatched.length, 2, "approved recovery must not dispatch the manifest twice");

  // The public route must replay the SQLite outcome even when its JSONL
  // presentation is absent (for example after offline compaction).
  rmSync(rowsDir(trackerDir), { recursive: true, force: true });
  const replay = await buildOcrApproveHandler({
    trackerDir,
    ensureDaemonsAndEnqueueOverride: enqueueOverride,
  })({
    sessionId: manifest.sessionId,
    runId: manifest.runId,
    records: manifest.records,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.ok && replay.body.state, "approved");
  assert.equal(dispatched.length, 2, "approved HTTP replay must not redispatch children");
});

test("a post-commit dispatch error releases approval for idempotent recovery instead of failing it", async () => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ocr-approval-partial-"));
  dirs.push(trackerDir);
  const store = openControlDb({ trackerDir });
  const manifest: OcrApprovalManifest = {
    version: 1,
    id: "manifest-partial",
    sessionId: "session-partial",
    runId: "ocr-run-partial",
    formType: "oath",
    parentRunId: "display-parent",
    records: [{ selected: true }],
    reviewData: {},
    children: [
      {
        kind: "record",
        workflow: "oath-signature",
        itemId: "signer-stable",
        runId: "signer-run-stable",
        input: { emplId: "10000001", dryRun: true },
      },
      {
        kind: "record",
        workflow: "person-lookup",
        itemId: "lookup-stable",
        runId: "lookup-run-stable",
        input: { emplId: "10000001", keepNonHdh: true },
      },
    ],
  };
  const requestHash = hashOcrApprovalRequest({ records: manifest.records });
  beginOcrApproval(store, {
    sessionId: manifest.sessionId,
    runId: manifest.runId,
    requestHash,
    manifest,
    ownerToken: "crashed-owner",
    allowAwaitingClaim: true,
    nowMs: 1_000,
    leaseMs: 10,
  });

  let failSecondGroupOnce = true;
  const committed = new Set<string>();
  const attempts: string[] = [];
  const enqueueOverride = (
    workflow: string,
    inputs: unknown[],
    deriveItemId: (input: unknown, index: number) => string,
    opts?: { runIds?: string[] },
  ) => {
    const ids = inputs.map((input, index) => deriveItemId(input, index));
    attempts.push(...ids);
    if (workflow === "person-lookup" && failSecondGroupOnce) {
      failSecondGroupOnce = false;
      throw new Error("wake failed after a different group committed");
    }
    ids.forEach((id) => committed.add(`${id}/${opts?.runIds?.[ids.indexOf(id)]}`));
    return Promise.resolve({ enqueued: ids.map((id, index) => ({ id, runId: opts?.runIds?.[index] })) });
  };

  assert.equal(await resumeRecoverableOcrApprovals(trackerDir, {
    nowMs: 1_011,
    ensureDaemonsAndEnqueueOverride: enqueueOverride,
  }), 0);
  const released = store.db.prepare(`
    SELECT state, lease_expires_at_ms, error FROM ocr_approvals
    WHERE session_id = ? AND run_id = ?
  `).get(manifest.sessionId, manifest.runId) as {
    state: string;
    lease_expires_at_ms: number;
    error: string | null;
  };
  assert.equal(released.state, "approving");
  assert.equal(released.lease_expires_at_ms, 0);
  assert.match(released.error ?? "", /wake failed/);

  assert.equal(await resumeRecoverableOcrApprovals(trackerDir, {
    nowMs: 1_012,
    ensureDaemonsAndEnqueueOverride: enqueueOverride,
  }), 1);
  assert.deepEqual([...committed].sort(), [
    "lookup-stable/lookup-run-stable",
    "signer-stable/signer-run-stable",
  ]);
  assert.deepEqual(attempts, ["signer-stable", "lookup-stable", "signer-stable", "lookup-stable"]);
  const approved = store.db.prepare(`
    SELECT state FROM ocr_approvals WHERE session_id = ? AND run_id = ?
  `).get(manifest.sessionId, manifest.runId) as { state: string };
  assert.equal(approved.state, "approved");
});

test("recovery preserves persisted record parallelism", async () => {
  const trackerDir = mkdtempSync(join(tmpdir(), "ocr-approval-parallel-"));
  dirs.push(trackerDir);
  const store = openControlDb({ trackerDir });
  const manifest: OcrApprovalManifest = {
    version: 1,
    id: "manifest-parallel",
    sessionId: "session-parallel",
    runId: "ocr-run-parallel",
    formType: "oath",
    parentRunId: "parent-parallel",
    records: [{ selected: true }],
    reviewData: { parallelWorkers: "3" },
    children: [{
      kind: "record",
      workflow: "oath-signature",
      itemId: "parallel-child",
      runId: "parallel-child-run",
      input: { emplId: "10000001", dryRun: true },
    }],
  };
  const requestHash = hashOcrApprovalRequest({ records: manifest.records });
  beginOcrApproval(store, {
    sessionId: manifest.sessionId,
    runId: manifest.runId,
    requestHash,
    manifest,
    ownerToken: "crashed-owner",
    allowAwaitingClaim: true,
    nowMs: 1_000,
    leaseMs: 10,
  });
  let flags: unknown;
  await resumeRecoverableOcrApprovals(trackerDir, {
    nowMs: 1_011,
    ensureDaemonsAndEnqueueOverride: (_workflow, inputs, deriveItemId, opts) => {
      flags = opts?.flags;
      return Promise.resolve({
        enqueued: inputs.map((input, index) => ({ id: deriveItemId(input, index) })),
      });
    },
  });
  assert.deepEqual(flags, { parallel: 3 });
});

for (const invalidWorkers of ["9", "1e3"]) {
  test(`recovery rejects unsafe persisted parallelWorkers=${invalidWorkers} without enqueueing`, async () => {
    const trackerDir = mkdtempSync(join(tmpdir(), "ocr-approval-invalid-workers-"));
    dirs.push(trackerDir);
    const store = openControlDb({ trackerDir });
    const manifest: OcrApprovalManifest = {
      version: 1,
      id: `manifest-invalid-workers-${invalidWorkers}`,
      sessionId: `session-invalid-workers-${invalidWorkers}`,
      runId: `ocr-run-invalid-workers-${invalidWorkers}`,
      formType: "oath",
      parentRunId: "parent-invalid-workers",
      records: [{ selected: true }],
      reviewData: { parallelWorkers: invalidWorkers },
      children: [{
        kind: "record",
        workflow: "oath-signature",
        itemId: "invalid-workers-child",
        runId: "invalid-workers-child-run",
        input: { emplId: "10000001", dryRun: true },
      }],
    };
    const requestHash = hashOcrApprovalRequest({ records: manifest.records });
    beginOcrApproval(store, {
      sessionId: manifest.sessionId,
      runId: manifest.runId,
      requestHash,
      manifest,
      ownerToken: "crashed-owner",
      allowAwaitingClaim: true,
      nowMs: 1_000,
      leaseMs: 10,
    });
    let enqueueCalled = false;
    assert.equal(await resumeRecoverableOcrApprovals(trackerDir, {
      nowMs: 1_011,
      ensureDaemonsAndEnqueueOverride: () => {
        enqueueCalled = true;
        return Promise.resolve({ enqueued: [] });
      },
    }), 0);
    assert.equal(enqueueCalled, false);
    const row = store.db.prepare(`
      SELECT state, lease_expires_at_ms, error FROM ocr_approvals
      WHERE session_id = ? AND run_id = ?
    `).get(manifest.sessionId, manifest.runId) as {
      state: string;
      lease_expires_at_ms: number;
      error: string | null;
    };
    assert.equal(row.state, "approving");
    assert.equal(row.lease_expires_at_ms, 0);
    assert.match(row.error ?? "", /invalid persisted worker count/);
  });
}
