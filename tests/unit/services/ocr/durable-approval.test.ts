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
  discardOcrApproval,
  listRecoverableOcrApprovals,
  markOcrAwaitingApproval,
  renewOcrApprovalLease,
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
    allowAwaitingClaim: true,
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
    allowAwaitingClaim: true,
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
    allowAwaitingClaim: true,
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
    allowAwaitingClaim: true,
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

test("a direct approval cannot create authority without an exact awaiting surface", () => {
  const control = setup();
  const result = beginOcrApproval(control, {
    sessionId: "session-stale",
    runId: "run-stale",
    requestHash: "stale-hash",
    manifest: manifest("stale", "session-stale", "run-stale"),
    ownerToken: "owner-stale",
  });
  assert.equal(result.kind, "stale");
  const count = control.db.prepare("SELECT COUNT(*) AS n FROM ocr_approvals").get() as { n: number };
  assert.equal(count.n, 0);
});

test("an expired approving lease is reclaimed with the persisted manifest and a new generation", () => {
  const control = setup();
  const firstManifest = manifest("lease-a", "session-lease", "run-lease");
  const first = beginOcrApproval(control, {
    sessionId: "session-lease", runId: "run-lease", requestHash: "lease-hash",
    manifest: firstManifest, ownerToken: "owner-a", nowMs: 1000, leaseMs: 50,
    allowAwaitingClaim: true,
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

test("lease renewal prevents startup recovery until the renewed lease expires", () => {
  const control = setup();
  const claimed = beginOcrApproval(control, {
    sessionId: "session-heartbeat", runId: "run-heartbeat", requestHash: "heartbeat-hash",
    manifest: manifest("heartbeat", "session-heartbeat", "run-heartbeat"),
    ownerToken: "owner-heartbeat", nowMs: 1_000, leaseMs: 50, allowAwaitingClaim: true,
  });
  assert.equal(claimed.kind, "claimed");
  renewOcrApprovalLease(control, {
    sessionId: "session-heartbeat", runId: "run-heartbeat", requestHash: "heartbeat-hash",
    ownerToken: "owner-heartbeat", generation: 1, nowMs: 1_040, leaseMs: 100,
  });
  assert.equal(listRecoverableOcrApprovals(control, 1_100).length, 0);
  assert.equal(listRecoverableOcrApprovals(control, 1_141).length, 1);
});

test("operator discard terminalizes a parked approval so it cannot be claimed", () => {
  const control = setup();
  markOcrAwaitingApproval(control, { sessionId: "session-discard", runId: "run-discard" });
  assert.equal(discardOcrApproval(control, {
    sessionId: "session-discard", runId: "run-discard", error: "operator discarded",
  }), "discarded");
  const replay = beginOcrApproval(control, {
    sessionId: "session-discard", runId: "run-discard", requestHash: "discard-hash",
    manifest: manifest("discard", "session-discard", "run-discard"), ownerToken: "owner",
    allowAwaitingClaim: true,
  });
  assert.equal(replay.kind, "failed");
});

test("discard cannot overwrite an approval that won the terminal race", () => {
  const control = setup();
  const approvedManifest = manifest("discard-race", "session-discard-race", "run-discard-race");
  const claim = beginOcrApproval(control, {
    sessionId: approvedManifest.sessionId,
    runId: approvedManifest.runId,
    requestHash: "discard-race-hash",
    manifest: approvedManifest,
    ownerToken: "approver",
    allowAwaitingClaim: true,
  });
  assert.equal(claim.kind, "claimed");
  completeOcrApproval(control, {
    sessionId: approvedManifest.sessionId,
    runId: approvedManifest.runId,
    requestHash: "discard-race-hash",
    ownerToken: "approver",
    generation: 1,
  });

  assert.equal(discardOcrApproval(control, {
    sessionId: approvedManifest.sessionId,
    runId: approvedManifest.runId,
    error: "late discard",
  }), "already-approved");
  const row = control.db.prepare(`
    SELECT state, error FROM ocr_approvals WHERE session_id = ? AND run_id = ?
  `).get(approvedManifest.sessionId, approvedManifest.runId) as { state: string; error: string | null };
  assert.equal(row.state, "approved");
  assert.equal(row.error, null);
});

test("discard inserts a terminal sentinel when no approval row exists yet", () => {
  const control = setup();
  assert.equal(discardOcrApproval(control, {
    sessionId: "session-discard-first",
    runId: "run-discard-first",
    error: "operator discarded before approval claim",
  }), "discarded");

  const staleApprover = beginOcrApproval(control, {
    sessionId: "session-discard-first",
    runId: "run-discard-first",
    requestHash: "stale-approval-hash",
    manifest: manifest("discard-first", "session-discard-first", "run-discard-first"),
    ownerToken: "stale-approver",
    allowAwaitingClaim: true,
  });
  assert.equal(staleApprover.kind, "failed");
});

test("a corrupt cross-run persisted manifest fails loudly instead of dispatching", () => {
  const control = setup();
  beginOcrApproval(control, {
    sessionId: "session-corrupt", runId: "run-corrupt", requestHash: "corrupt-hash",
    manifest: manifest("corrupt", "session-corrupt", "run-corrupt"), ownerToken: "owner-a",
    allowAwaitingClaim: true,
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
