import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { trackEvent, appendLogEntry } from "../../../src/tracker/jsonl.js";
import { queryEntriesPayload, queryRunsForItem } from "../../../src/tracker/state/queries.js";

function tmpTracker(): string {
  return mkdtempSync(join(tmpdir(), "state-query-"));
}

test("queryEntriesPayload returns /events-compatible entries and counts", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({
      workflow: "onboarding",
      timestamp: "2026-05-04T20:00:00.000Z",
      id: "jane",
      runId: "run-1",
      status: "running",
      step: "extraction",
      data: { __name: "Jane Doe" },
    }, dir);
    appendLogEntry({
      workflow: "onboarding",
      itemId: "jane",
      runId: "run-1",
      level: "step",
      message: "Extracting",
      ts: "2026-05-04T20:00:10.000Z",
    }, dir);
    const db = openStateDb(dir);
    const payload = queryEntriesPayload(db, { workflow: "onboarding", date: "2026-05-04" });
    assert.equal(payload.workflows.includes("onboarding"), true);
    assert.equal(payload.wfCounts.onboarding, 1);
    assert.equal(payload.entries.length, 1);
    const entry = payload.entries[0] as { id: string; firstLogTs?: string; lastLogMessage?: string; runOrdinal?: number };
    assert.equal(entry.id, "jane");
    assert.equal(entry.firstLogTs, "2026-05-04T20:00:00.000Z");
    assert.equal(entry.lastLogMessage, "Extracting");
    assert.equal(entry.runOrdinal, 1);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryRunsForItem returns /api/runs-compatible run summaries", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({
      workflow: "work-study",
      timestamp: "2026-05-04T20:00:00.000Z",
      id: "10000001",
      runId: "run-1",
      status: "running",
      step: "transaction",
    }, dir);
    trackEvent({
      workflow: "work-study",
      timestamp: "2026-05-04T20:01:00.000Z",
      id: "10000001",
      runId: "run-1",
      status: "done",
    }, dir);
    const db = openStateDb(dir);
    const runs = queryRunsForItem(db, { workflow: "work-study", itemId: "10000001", date: "2026-05-04" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "done");
    assert.equal(runs[0].runOrdinal, 1);
    assert.equal(runs[0].stepDurations?.transaction, 60_000);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
