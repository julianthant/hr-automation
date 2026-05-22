import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeStateDbForTests,
  isStateDbReady,
  openStateDb,
  stateDbPath,
} from "../../../src/tracker/state/db.js";
import { LATEST_SCHEMA_VERSION } from "../../../src/tracker/state/schema.js";

function tmpTracker(): string {
  return mkdtempSync(join(tmpdir(), "state-db-"));
}

test("openStateDb creates .tracker/state.db with WAL and NORMAL synchronous", () => {
  const dir = tmpTracker();
  try {
    const db = openStateDb(dir);
    assert.equal(stateDbPath(dir), join(dir, "state.db"));
    assert.equal(existsSync(join(dir, "state.db")), true);
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const sync = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    assert.equal(journal.journal_mode.toLowerCase(), "wal");
    assert.equal(sync.synchronous, 1);
    const version = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    assert.equal(version.version, LATEST_SCHEMA_VERSION);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openStateDb is idempotent for an already migrated DB", () => {
  const dir = tmpTracker();
  try {
    const first = openStateDb(dir);
    const firstVersion = first.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    closeStateDbForTests(dir);
    const second = openStateDb(dir);
    const secondVersion = second.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    assert.equal(secondVersion.version, firstVersion.version);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

// C1: isStateDbReady must not trust a stale positive forever — if the DB file
// is deleted after the first successful probe, readiness must flip to false.
test("isStateDbReady invalidates the ready cache when the DB file is deleted", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    assert.equal(isStateDbReady(dir), true, "freshly opened DB should be ready");
    // Drop the cached open handle, then delete the file out from under us.
    closeStateDbForTests(dir);
    unlinkSync(stateDbPath(dir));
    assert.equal(isStateDbReady(dir), false, "deleted DB file must report not-ready");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

// C1: isStateDbReady must re-probe (and reject) when the DB file is replaced
// with a different/corrupt file after the cache was warmed.
test("isStateDbReady invalidates the ready cache when the DB file is corrupted", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    assert.equal(isStateDbReady(dir), true);
    closeStateDbForTests(dir);
    // Overwrite with garbage so the schema-version probe fails.
    writeFileSync(stateDbPath(dir), "not a sqlite database");
    assert.equal(isStateDbReady(dir), false, "corrupted DB file must report not-ready");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v6 baseline defines session_events.tracker_date default empty", () => {
  const dir = tmpTracker();
  try {
    const db = openStateDb(dir);
    assert.equal(
      (db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }).version,
      LATEST_SCHEMA_VERSION,
    );
    db.prepare(`
      INSERT INTO session_events (
        source_path,
        source_line,
        source_offset,
        event_type,
        workflow_instance,
        run_id,
        timestamp,
        ts_ms,
        raw_json,
        applied_at
      ) VALUES (
        @sourcePath,
        @sourceLine,
        @sourceOffset,
        'session',
        'ocr:session-1',
        'run-1',
        @timestamp,
        @tsMs,
        '{}',
        '2026-05-04T12:00:00.000Z'
      )
    `).run({
      sourcePath: "sessions.jsonl",
      sourceLine: 1,
      sourceOffset: 0,
      timestamp: "2026-05-04T12:34:56.000Z",
      tsMs: Date.parse("2026-05-04T12:34:56.000Z"),
    });
    const row = db
      .prepare(`SELECT tracker_date AS trackerDate FROM session_events WHERE source_line = 1`)
      .get() as { trackerDate: string };
    assert.equal(row.trackerDate, "");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
