import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import {
  closeStateDbForTests,
  openStateDb,
  runMigrations,
  stateDbPath,
} from "../../../src/tracker/state/db.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "../../../src/tracker/state/schema.js";

function tmpTracker(): string {
  return mkdtempSync(join(tmpdir(), "state-db-"));
}

test("openStateDb creates .tracker/state.db with WAL and NORMAL synchronous", () => {
  const dir = tmpTracker();
  try {
    const db = openStateDb(dir);
    assert.equal(stateDbPath(dir), join(dir, "state.db"));
    assert.equal(existsSync(join(dir, "state.db")), true);
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(Number(db.pragma("synchronous", { simple: true })), 1);
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

test("migration 4 backfills session event tracker_date from timestamp", () => {
  const dir = tmpTracker();
  const dbPath = join(dir, "state.db");
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 3)) {
      db.exec(migration.sql);
    }
    db.prepare(`
      INSERT INTO schema_version (id, version, applied_at)
      VALUES (1, 3, '2026-05-04T12:00:00.000Z')
    `).run();
    const insert = db.prepare(`
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
    `);
    insert.run({
      sourcePath: "sessions.jsonl",
      sourceLine: 1,
      sourceOffset: 0,
      timestamp: "2026-05-04T12:34:56.000Z",
      tsMs: Date.parse("2026-05-04T12:34:56.000Z"),
    });
    insert.run({
      sourcePath: "sessions.jsonl",
      sourceLine: 2,
      sourceOffset: 100,
      timestamp: "bad-value",
      tsMs: 0,
    });

    runMigrations(db);

    const version = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    assert.equal(version.version, 4);
    const rows = db.prepare(`
      SELECT source_line AS sourceLine, tracker_date AS trackerDate
      FROM session_events
      ORDER BY source_line
    `).all() as Array<{ sourceLine: number; trackerDate: string }>;
    assert.deepEqual(rows, [
      { sourceLine: 1, trackerDate: "2026-05-04" },
      { sourceLine: 2, trackerDate: "bad-value" },
    ]);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
