import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trackEvent } from "../../../../src/tracker/jsonl.js";
import { findPriorRunsForHash } from "../../../../src/workflows/oath-upload/duplicate-check.js";

test("findPriorRunsForHash: returns prior runs with matching pdfHash, dedup latest run per sessionId, newest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-dup-"));
  try {
    const hash = "a".repeat(64);

    // session-1 has two runs; only the latest (run-2) should appear in the result.
    trackEvent({
      workflow: "oath-upload",
      timestamp: "2026-04-25T10:00:00Z",
      id: "session-1", runId: "run-1",
      status: "done", step: "submit",
      data: { pdfHash: hash, ticketNumber: "HRC0123456", pdfOriginalName: "x.pdf" },
    }, dir);
    trackEvent({
      workflow: "oath-upload",
      timestamp: "2026-04-26T10:00:00Z",
      id: "session-1", runId: "run-2",
      status: "failed", step: "fill-form",
      data: { pdfHash: hash, pdfOriginalName: "x.pdf" },
    }, dir);

    // session-2: different sessionId, same hash — should appear separately.
    trackEvent({
      workflow: "oath-upload",
      timestamp: "2026-04-20T10:00:00Z",
      id: "session-2", runId: "run-3",
      status: "done", step: "submit",
      data: { pdfHash: hash, ticketNumber: "HRC0123455", pdfOriginalName: "x.pdf" },
    }, dir);

    // session-3: different hash — must NOT appear.
    trackEvent({
      workflow: "oath-upload",
      timestamp: "2026-04-29T10:00:00Z",
      id: "session-3", runId: "run-4",
      status: "done", step: "submit",
      data: { pdfHash: "b".repeat(64), pdfOriginalName: "y.pdf" },
    }, dir);

    const result = findPriorRunsForHash({ hash, trackerDir: dir });
    assert.equal(result.length, 2);
    // Newest first: session-1's latest run (2026-04-26) before session-2 (2026-04-20).
    assert.equal(result[0].sessionId, "session-1");
    assert.equal(result[0].runId, "run-2");
    assert.equal(result[0].terminalStep, "fill-form");
    assert.equal(result[0].status, "failed");
    assert.equal(result[1].sessionId, "session-2");
    assert.equal(result[1].ticketNumber, "HRC0123455");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findPriorRunsForHash: returns empty when no priors exist", () => {
  const result = findPriorRunsForHash({
    hash: "z".repeat(64),
    trackerDir: `/tmp/nonexistent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
  assert.deepEqual(result, []);
});

test("findPriorRunsForHash: ignores entries with no pdfHash", () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-dup-nohash-"));
  try {
    trackEvent({
      workflow: "oath-upload",
      timestamp: "2026-04-29T10:00:00Z",
      id: "s", runId: "r",
      status: "done", step: "submit",
      data: { pdfOriginalName: "x.pdf" },  // no pdfHash
    }, dir);
    const r = findPriorRunsForHash({ hash: "a".repeat(64), trackerDir: dir });
    assert.deepEqual(r, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
