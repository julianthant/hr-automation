import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeStateDbForTests,
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
