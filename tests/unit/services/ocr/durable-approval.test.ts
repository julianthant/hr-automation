import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";

import { openControlDb } from "../../../../src/core/control-db.js";
import {
  beginOcrApproval,
  completeOcrApproval,
  failOcrApproval,
  hashOcrApprovalRequest,
  type OcrApprovalManifest,
} from "../../../../src/tracker/state/ocr-approval-store.js";

const dirs: string[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ocr-approval-store-"));
  dirs.push(dir);
  return openControlDb({ trackerDir: dir });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manifest(suffix: string, sessionId = "session", runId = "run"): OcrApprovalManifest {
  return {
    version: 1,
    id: `manifest-${suffix}`,
    sessionId,
    runId,
    formType: "oath",
    parentRunId: "parent-run",
    records: [],
    reviewData: {},
    children: [
      { kind: "record", workflow: "oath-signature", itemId: "signer-1", runId: `run-${suffix}`, input: { emplId: "10000001" } },
    ],
  };
}

test("approval claim is atomic and identical concurrent requests reuse the first manifest", () => {
  const control = setup();
  const requestHash = hashOcrApprovalRequest({ records: [{ selected: true, employeeId: "10000001" }] });
  const first = beginOcrApproval(control, {
    sessionId: "session-1",
    runId: "ocr-run-1",
    requestHash,
    manifest: manifest("a", "session-1", "ocr-run-1"),
    ownerToken: "owner-a",
  });
  const replay = beginOcrApproval(control, {
    sessionId: "session-1",
    runId: "ocr-run-1",
    requestHash,
    manifest: manifest("b", "session-1", "ocr-run-1"),
    ownerToken: "owner-b",
  });

  assert.equal(first.kind, "claimed");
  assert.equal(replay.kind, "pending");
  assert.deepEqual(replay.manifest, manifest("a", "session-1", "ocr-run-1"));
});

test("conflicting request hash cannot replace an in-flight approval manifest", () => {
  const control = setup();
  beginOcrApproval(control, {
    sessionId: "session-2",
    runId: "ocr-run-2",
    requestHash: "hash-a",
    manifest: manifest("a", "session-2", "ocr-run-2"),
    ownerToken: "owner-a",
  });

  const conflict = beginOcrApproval(control, {
    sessionId: "session-2",
    runId: "ocr-run-2",
    requestHash: "hash-b",
    manifest: manifest("b", "session-2", "ocr-run-2"),
    ownerToken: "owner-b",
  });
  assert.equal(conflict.kind, "conflict");
  assert.deepEqual(conflict.manifest, manifest("a", "session-2", "ocr-run-2"));
});

test("approved and failed outcomes are durable and replayed without redispatch", () => {
  const control = setup();
  const approvedHash = "approved-hash";
  const approvedManifest = manifest("approved", "session-3", "ocr-run-3");
  const claim = beginOcrApproval(control, {
    sessionId: "session-3",
    runId: "ocr-run-3",
    requestHash: approvedHash,
    manifest: approvedManifest,
    ownerToken: "owner-approved",
  });
  assert.equal(claim.kind, "claimed");
  completeOcrApproval(control, {
    sessionId: "session-3", runId: "ocr-run-3", requestHash: approvedHash,
    ownerToken: "owner-approved", generation: 1,
  });
  assert.equal(
    beginOcrApproval(control, {
      sessionId: "session-3",
      runId: "ocr-run-3",
      requestHash: approvedHash,
      manifest: manifest("ignored", "session-3", "ocr-run-3"),
      ownerToken: "owner-replay",
    }).kind,
    "approved",
  );

  const failedHash = "failed-hash";
  beginOcrApproval(control, {
    sessionId: "session-4",
    runId: "ocr-run-4",
    requestHash: failedHash,
    manifest: manifest("failed", "session-4", "ocr-run-4"),
    ownerToken: "owner-failed",
  });
  failOcrApproval(control, {
    sessionId: "session-4",
    runId: "ocr-run-4",
    requestHash: failedHash,
    ownerToken: "owner-failed",
    generation: 1,
    error: "loader unavailable",
  });
  const failed = beginOcrApproval(control, {
    sessionId: "session-4",
    runId: "ocr-run-4",
    requestHash: failedHash,
    manifest: manifest("ignored", "session-4", "ocr-run-4"),
    ownerToken: "owner-replay",
  });
  assert.equal(failed.kind, "failed");
  if (failed.kind === "failed") assert.equal(failed.error, "loader unavailable");
});

test("request hashing is canonical across object key insertion order", () => {
  assert.equal(
    hashOcrApprovalRequest({ records: [{ b: 2, a: 1 }] }),
    hashOcrApprovalRequest({ records: [{ a: 1, b: 2 }] }),
  );
});

test("an expired approving lease is reclaimed with the persisted manifest and a new generation", () => {
  const control = setup();
  const firstManifest = manifest("lease-a", "session-lease", "run-lease");
  const first = beginOcrApproval(control, {
    sessionId: "session-lease", runId: "run-lease", requestHash: "lease-hash",
    manifest: firstManifest, ownerToken: "owner-a", nowMs: 1000, leaseMs: 50,
  });
  assert.equal(first.kind, "claimed");
  const reclaimed = beginOcrApproval(control, {
    sessionId: "session-lease", runId: "run-lease", requestHash: "lease-hash",
    manifest: manifest("lease-b", "session-lease", "run-lease"),
    ownerToken: "owner-b", nowMs: 1051, leaseMs: 50,
  });
  assert.equal(reclaimed.kind, "claimed");
  if (reclaimed.kind === "claimed") {
    assert.equal(reclaimed.generation, 2);
    assert.deepEqual(reclaimed.manifest, firstManifest);
  }
});

test("a corrupt cross-run persisted manifest fails loudly instead of dispatching", () => {
  const control = setup();
  beginOcrApproval(control, {
    sessionId: "session-corrupt", runId: "run-corrupt", requestHash: "corrupt-hash",
    manifest: manifest("corrupt", "session-corrupt", "run-corrupt"), ownerToken: "owner-a",
  });
  control.db.prepare(`
    UPDATE ocr_approvals SET manifest_json = @manifest
    WHERE session_id = 'session-corrupt' AND run_id = 'run-corrupt'
  `).run({ manifest: JSON.stringify(manifest("wrong", "different-session", "different-run")) });
  assert.throws(
    () => beginOcrApproval(control, {
      sessionId: "session-corrupt", runId: "run-corrupt", requestHash: "corrupt-hash",
      manifest: manifest("ignored", "session-corrupt", "run-corrupt"), ownerToken: "owner-b",
    }),
    /corrupt fan-out manifest/i,
  );
});
