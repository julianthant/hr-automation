import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { trackEvent, appendLogEntry } from "../../../src/tracker/jsonl.js";
import { queryEntriesPayload, queryRunsForItem, queryPriorEntriesByKey } from "../../../src/tracker/state/queries.js";

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

// ── queryPriorEntriesByKey ────────────────────────────────────────────────────

test("queryPriorEntriesByKey: returns rows where data[key] === value", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    // Two items with matching eid, one without.
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T10:00:00.000Z", id: "doc-1", runId: "r1", status: "done", data: { eid: "10001" } }, dir);
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T11:00:00.000Z", id: "doc-2", runId: "r2", status: "done", data: { eid: "10001" } }, dir);
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T12:00:00.000Z", id: "doc-3", runId: "r3", status: "done", data: { eid: "99999" } }, dir);
    const db = openStateDb(dir);
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "eid",
      keyValue: "10001",
      cutoffDate: "2026-01-01",
    });
    assert.equal(rows.length, 2);
    // Both must have eid 10001.
    for (const row of rows) {
      assert.equal((row.data as Record<string, string>).eid, "10001");
    }
    // Should not include doc-3 (different eid).
    assert.equal(rows.find((r) => r.id === "doc-3"), undefined);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryPriorEntriesByKey: respects cutoffDate — excludes rows before cutoff", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    // Old entry (before cutoff).
    trackEvent({ workflow: "separations", timestamp: "2026-01-01T00:00:00.000Z", id: "doc-old", runId: "r-old", status: "done", data: { eid: "10002" } }, dir);
    // Recent entry (on or after cutoff).
    trackEvent({ workflow: "separations", timestamp: "2026-04-01T00:00:00.000Z", id: "doc-new", runId: "r-new", status: "done", data: { eid: "10002" } }, dir);
    const db = openStateDb(dir);
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "eid",
      keyValue: "10002",
      cutoffDate: "2026-03-01", // doc-old is on 2026-01-01, which is before this.
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "doc-new");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryPriorEntriesByKey: returns empty array when no match", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T10:00:00.000Z", id: "doc-1", runId: "r1", status: "done", data: { eid: "10001" } }, dir);
    const db = openStateDb(dir);
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "eid",
      keyValue: "NOMATCH",
      cutoffDate: "2026-01-01",
    });
    assert.equal(rows.length, 0);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryPriorEntriesByKey: excludeId omits the caller's own entry", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T10:00:00.000Z", id: "doc-self", runId: "r1", status: "done", data: { eid: "10003" } }, dir);
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T11:00:00.000Z", id: "doc-other", runId: "r2", status: "done", data: { eid: "10003" } }, dir);
    const db = openStateDb(dir);
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "eid",
      keyValue: "10003",
      excludeId: "doc-self",
      cutoffDate: "2026-01-01",
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "doc-other");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryPriorEntriesByKey: cancelled and discarded entries are excluded", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    // A cancelled entry (status=failed, step=cancelled).
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T09:00:00.000Z", id: "doc-cancelled", runId: "r1", status: "failed", step: "cancelled", data: { eid: "10004" } }, dir);
    // A discarded entry (status=failed, step=discarded).
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T09:30:00.000Z", id: "doc-discarded", runId: "r2", status: "failed", step: "discarded", data: { eid: "10004" } }, dir);
    // A real failure (status=failed, step=something else) — should be included.
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T10:00:00.000Z", id: "doc-failed", runId: "r3", status: "failed", step: "extraction", data: { eid: "10004" } }, dir);
    const db = openStateDb(dir);
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "eid",
      keyValue: "10004",
      cutoffDate: "2026-01-01",
    });
    // Only the real failure should be included; cancelled and discarded are excluded.
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "doc-failed");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryPriorEntriesByKey: dedupes by item_id keeping latest timestamp", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    // Same item_id, two dates — should return only the latest.
    trackEvent({ workflow: "separations", timestamp: "2026-04-01T10:00:00.000Z", id: "doc-1", runId: "r1", status: "done", data: { eid: "10005" } }, dir);
    trackEvent({ workflow: "separations", timestamp: "2026-05-01T10:00:00.000Z", id: "doc-1", runId: "r2", status: "done", data: { eid: "10005" } }, dir);
    const db = openStateDb(dir);
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "eid",
      keyValue: "10005",
      cutoffDate: "2026-01-01",
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "doc-1");
    // Should be the latest run (r2).
    assert.equal(rows[0].runId, "r2");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryPriorEntriesByKey: trims whitespace in stored value — matches trimmed query value", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    // Store an entry whose data value has surrounding whitespace.
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T10:00:00.000Z", id: "doc-ws", runId: "r1", status: "done", data: { name: "  Jane Doe  " } }, dir);
    const db = openStateDb(dir);
    // Query with the trimmed value — must match despite stored whitespace.
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "name",
      keyValue: "Jane Doe",
      cutoffDate: "2026-01-01",
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "doc-ws");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryPriorEntriesByKey: key with special chars (quotes, dots) does not throw", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T10:00:00.000Z", id: "doc-1", runId: "r1", status: "done", data: { normalKey: "val" } }, dir);
    const db = openStateDb(dir);
    // Keys with quotes/dots/special chars should not throw — they return no results
    // since those are not valid top-level data keys in practice.
    assert.doesNotThrow(() => {
      queryPriorEntriesByKey(db, { workflow: "separations", keyField: "key'with'quotes", keyValue: "val", cutoffDate: "2026-01-01" });
    });
    assert.doesNotThrow(() => {
      queryPriorEntriesByKey(db, { workflow: "separations", keyField: "key.with.dots", keyValue: "val", cutoffDate: "2026-01-01" });
    });
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
