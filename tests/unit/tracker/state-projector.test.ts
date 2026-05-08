import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { rebuildProjectionForDate } from "../../../src/tracker/state/rebuild.js";

function tmpTracker(): string {
  return mkdtempSync(join(tmpdir(), "state-rebuild-"));
}

test("rebuildProjectionForDate replays tracker and log JSONL into SQLite", () => {
  const dir = tmpTracker();
  const date = "2026-05-04";
  try {
    appendFileSync(join(dir, `onboarding-${date}.jsonl`), JSON.stringify({
      workflow: "onboarding",
      timestamp: "2026-05-04T20:00:00.000Z",
      id: "jane",
      runId: "run-1",
      status: "running",
      step: "extraction",
      data: { name: "Jane" },
    }) + "\n");
    appendFileSync(join(dir, `onboarding-${date}-logs.jsonl`), JSON.stringify({
      workflow: "onboarding",
      itemId: "jane",
      runId: "run-1",
      level: "step",
      message: "Extracting",
      ts: "2026-05-04T20:00:10.000Z",
    }) + "\n");

    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date });
    const run = db.prepare("SELECT latest_status, latest_step, last_log_message FROM runs").get() as {
      latest_status: string;
      latest_step: string;
      last_log_message: string;
    };
    assert.deepEqual({ ...run }, {
      latest_status: "running",
      latest_step: "extraction",
      last_log_message: "Extracting",
    });
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuildProjectionForDate is idempotent and skips malformed lines", () => {
  const dir = tmpTracker();
  const date = "2026-05-04";
  try {
    appendFileSync(join(dir, `work-study-${date}.jsonl`), "{bad json}\n");
    appendFileSync(join(dir, `work-study-${date}.jsonl`), JSON.stringify({
      workflow: "work-study",
      timestamp: "2026-05-04T20:00:00.000Z",
      id: "10000001",
      runId: "run-1",
      status: "done",
    }) + "\n");

    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date });
    rebuildProjectionForDate(db, { dir, date });
    const count = db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as { n: number };
    assert.equal(count.n, 1);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuildProjectionForDate skips sessions-${date}.jsonl in the tracker loop", () => {
  // Regression: sessions-${date}.jsonl matches the `-${date}.jsonl` suffix
  // and was being parsed as a tracker file with workflow="sessions".
  // Session events have no `workflow` field, so `applyTrackerEntry` failed
  // bind on parameter 4 (@workflow), aborting the projection rebuild.
  const dir = tmpTracker();
  const date = "2026-05-04";
  try {
    appendFileSync(join(dir, `sessions-${date}.jsonl`), JSON.stringify({
      type: "workflow_start",
      timestamp: "2026-05-04T20:00:00.000Z",
      pid: 1,
      workflowInstance: "Today 1",
      runId: "run-1",
    }) + "\n");

    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date });
    const trackerCount = db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as { n: number };
    const sessionCount = db.prepare("SELECT COUNT(*) AS n FROM session_events").get() as { n: number };
    assert.equal(trackerCount.n, 0, "session file must not produce tracker rows");
    assert.equal(sessionCount.n, 1, "session file must still flow through the session loop");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuildProjectionForDate applies only new bytes on second call (incremental)", () => {
  const dir = tmpTracker();
  const date = "2026-05-04";
  try {
    const trackerPath = join(dir, `onboarding-${date}.jsonl`);

    // First write: one entry
    appendFileSync(trackerPath, JSON.stringify({
      workflow: "onboarding",
      timestamp: "2026-05-04T20:00:00.000Z",
      id: "alice",
      runId: "run-1",
      status: "done",
      data: { name: "Alice" },
    }) + "\n");

    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date });
    const countAfterFirst = (db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as { n: number }).n;
    assert.equal(countAfterFirst, 1, "first rebuild should produce 1 run_event");

    // Second write: a new entry appended after the first rebuild
    appendFileSync(trackerPath, JSON.stringify({
      workflow: "onboarding",
      timestamp: "2026-05-04T21:00:00.000Z",
      id: "bob",
      runId: "run-2",
      status: "done",
      data: { name: "Bob" },
    }) + "\n");

    rebuildProjectionForDate(db, { dir, date });
    const countAfterSecond = (db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as { n: number }).n;
    assert.equal(countAfterSecond, 2, "second rebuild should add only the new entry");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuildProjectionForDate only clears session events for the rebuilt date", () => {
  const dir = tmpTracker();
  try {
    appendFileSync(join(dir, "sessions.jsonl"), JSON.stringify({
      type: "workflow_start",
      timestamp: "2026-05-03T20:00:00.000Z",
      pid: 1,
      workflowInstance: "Yesterday 1",
      runId: "run-yesterday",
    }) + "\n");
    appendFileSync(join(dir, "sessions.jsonl"), JSON.stringify({
      type: "workflow_start",
      timestamp: "2026-05-04T20:00:00.000Z",
      pid: 1,
      workflowInstance: "Today 1",
      runId: "run-today",
    }) + "\n");

    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date: "2026-05-03" });
    rebuildProjectionForDate(db, { dir, date: "2026-05-04" });

    const rows = db.prepare(`
      SELECT tracker_date, workflow_instance
      FROM session_events
      ORDER BY tracker_date ASC
    `).all() as Array<{ tracker_date: string; workflow_instance: string }>;
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { tracker_date: "2026-05-03", workflow_instance: "Yesterday 1" },
      { tracker_date: "2026-05-04", workflow_instance: "Today 1" },
    ]);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuild handles JSONL truncation by re-reading from offset 0", () => {
  // Regression: without truncation detection, stat.size <= cached byte_offset
  // causes parseJsonlFrom to return [] forever, so any bytes appended after the
  // truncation point are never parsed. The fix resets effectiveStart to 0 when
  // stat.size < startAt; INSERT OR IGNORE on UNIQUE(source_path, source_offset)
  // absorbs lines whose byte offsets collide with pre-truncation DB rows as a
  // no-op, but lines at novel offsets still land.
  //
  // To produce novel offsets after truncation we use long original entries
  // (so their line lengths differ from the short replacement entries), making
  // the second short line sit at a byte offset that the original file never had.
  const dir = tmpTracker();
  const date = "2026-05-08";
  try {
    const path = join(dir, `separations-${date}.jsonl`);

    // Write 2 long entries — large enough that a 2-entry replacement file
    // (with shorter lines) will be smaller than this file's total size.
    const longSuffix = { data: { name: "Alice Smith Johnson III — long field to widen the line" } };
    appendFileSync(path, JSON.stringify({ workflow: "separations", id: "long-1", runId: "long-1#1", status: "pending", timestamp: "2026-05-08T10:00:00Z", ...longSuffix }) + "\n");
    appendFileSync(path, JSON.stringify({ workflow: "separations", id: "long-2", runId: "long-2#1", status: "pending", timestamp: "2026-05-08T10:01:00Z", ...longSuffix }) + "\n");
    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date });
    const before = db.prepare(`SELECT COUNT(*) AS n FROM run_events WHERE workflow = 'separations' AND tracker_date = ?`).get(date) as { n: number };
    assert.equal(before.n, 2, "first rebuild should produce 2 run_events");

    // Truncate the file by rewriting it with 2 short entries.  The short lines
    // are narrower than the originals, so the second short entry sits at a byte
    // offset that no existing run_event row has — it will pass INSERT OR IGNORE.
    // The new file is also smaller than the cached byte_offset, triggering the
    // truncation-detection branch (effectiveStart = 0) introduced in this fix.
    // Without the fix, stat.size <= startAt → [] forever.
    writeFileSync(path,
      JSON.stringify({ workflow: "separations", id: "short-1", runId: "short-1#1", status: "pending", timestamp: "2026-05-08T11:00:00Z" }) + "\n" +
      JSON.stringify({ workflow: "separations", id: "short-2", runId: "short-2#1", status: "pending", timestamp: "2026-05-08T11:01:00Z" }) + "\n",
    );
    rebuildProjectionForDate(db, { dir, date });

    // short-2 sits at an offset that was not present in the original file
    // (the long lines are wider than the short lines), so INSERT OR IGNORE
    // lets it through. long-1 and long-2 remain (no DELETE on truncation).
    const after = db.prepare(`SELECT COUNT(*) AS n FROM run_events WHERE workflow = 'separations' AND tracker_date = ?`).get(date) as { n: number };
    assert.ok(after.n >= 3, `expected at least 3 rows (2 original + short-2 at novel offset), got ${after.n}`);
    const short2Row = db.prepare(`SELECT 1 FROM run_events WHERE workflow = 'separations' AND item_id = 'short-2'`).get();
    assert.ok(short2Row, "short-2 (post-truncation entry at novel offset) should be present");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
