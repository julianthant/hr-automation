import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trackEvent } from "../../../../src/tracker/jsonl.js";
import { openStateDb, closeStateDbForTests } from "../../../../src/tracker/state/db.js";
import { findPriorRunsForHash } from "../../../../src/workflows/oath-upload/duplicate-check.js";

/**
 * ISO timestamp for N days before now, anchored to noon local time so both
 * runs for a given session land on the same tracker_date regardless of when
 * the test runs (avoids UTC/local boundary flips near midnight).
 */
function localNoonDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

test("findPriorRunsForHash: returns prior runs with matching pdfHash, dedup latest run per sessionId, newest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-dup-"));
  openStateDb(dir);
  try {
    const hash = "a".repeat(64);

    // session-1 has two runs on the SAME local day (same tracker_date → one items
    // row, upserted to the later run-2 entry); only run-2 should appear in the result.
    trackEvent({
      workflow: "oath-upload",
      timestamp: localNoonDaysAgo(5),
      id: "session-1", runId: "run-1",
      status: "done", step: "submit",
      data: { pdfHash: hash, ticketNumber: "HRC0123456", pdfOriginalName: "x.pdf" },
    }, dir);
    trackEvent({
      workflow: "oath-upload",
      timestamp: new Date(new Date(localNoonDaysAgo(5)).getTime() + 3_600_000).toISOString(),
      id: "session-1", runId: "run-2",
      status: "failed", step: "fill-form",
      data: { pdfHash: hash, pdfOriginalName: "x.pdf" },
    }, dir);

    // session-2: different sessionId, same hash — should appear separately.
    trackEvent({
      workflow: "oath-upload",
      timestamp: localNoonDaysAgo(11),
      id: "session-2", runId: "run-3",
      status: "done", step: "submit",
      data: { pdfHash: hash, ticketNumber: "HRC0123455", pdfOriginalName: "x.pdf" },
    }, dir);

    // session-3: different hash — must NOT appear.
    trackEvent({
      workflow: "oath-upload",
      timestamp: localNoonDaysAgo(2),
      id: "session-3", runId: "run-4",
      status: "done", step: "submit",
      data: { pdfHash: "b".repeat(64), pdfOriginalName: "y.pdf" },
    }, dir);

    const result = findPriorRunsForHash({ hash, trackerDir: dir });
    assert.equal(result.length, 2);
    // Newest first: session-1's latest run (5 days ago) before session-2 (11 days ago).
    assert.equal(result[0].sessionId, "session-1");
    assert.equal(result[0].runId, "run-2");
    assert.equal(result[0].terminalStep, "fill-form");
    assert.equal(result[0].status, "failed");
    assert.equal(result[1].sessionId, "session-2");
    assert.equal(result[1].ticketNumber, "HRC0123455");
  } finally {
    closeStateDbForTests(dir);
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
  openStateDb(dir);
  try {
    trackEvent({
      workflow: "oath-upload",
      timestamp: localNoonDaysAgo(2),
      id: "s", runId: "r",
      status: "done", step: "submit",
      data: { pdfOriginalName: "x.pdf" },  // no pdfHash
    }, dir);
    const r = findPriorRunsForHash({ hash: "a".repeat(64), trackerDir: dir });
    assert.deepEqual(r, []);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
