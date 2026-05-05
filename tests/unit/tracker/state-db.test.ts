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
