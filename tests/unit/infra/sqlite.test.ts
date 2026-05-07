import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, transaction, type Database } from "../../../src/infra/sqlite/index.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sqlite-shim-test-"));
}

test("openDatabase creates parent directory if missing", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "nested", "deep", "test.db");
    const db = openDatabase(path);
    assert.equal(existsSync(path), true);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDatabase applies default pragmas", () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(join(dir, "test.db"));
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const sync = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    assert.equal(journal.journal_mode.toLowerCase(), "wal");
    assert.equal(sync.synchronous, 1);
    assert.equal(fk.foreign_keys, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDatabase honors applyDefaultPragmas: false", () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(join(dir, "test.db"), { applyDefaultPragmas: false });
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.notEqual(journal.journal_mode.toLowerCase(), "wal");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDatabase fileMustExist throws when missing", () => {
  const dir = makeTempDir();
  try {
    assert.throws(
      () => openDatabase(join(dir, "missing.db"), { fileMustExist: true }),
      /not found/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDatabase readonly opens existing file without applying pragmas", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "test.db");
    // Create + populate.
    const writer = openDatabase(path);
    writer.exec("CREATE TABLE t(x INTEGER)");
    writer.exec("INSERT INTO t VALUES (1)");
    writer.close();

    // Read-only re-open.
    const reader = openDatabase(path, { readonly: true });
    const row = reader.prepare("SELECT x FROM t").get() as { x: number };
    assert.equal(row.x, 1);
    assert.throws(() => reader.exec("INSERT INTO t VALUES (2)"));
    reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transaction commits on success", () => {
  const dir = makeTempDir();
  try {
    const db: Database = openDatabase(join(dir, "test.db"));
    db.exec("CREATE TABLE t(x INTEGER)");
    transaction(db, () => {
      db.exec("INSERT INTO t VALUES (1)");
      db.exec("INSERT INTO t VALUES (2)");
    });
    const rows = db.prepare("SELECT x FROM t ORDER BY x").all() as { x: number }[];
    assert.deepEqual(rows.map((r) => r.x), [1, 2]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transaction rolls back on throw and re-throws", () => {
  const dir = makeTempDir();
  try {
    const db: Database = openDatabase(join(dir, "test.db"));
    db.exec("CREATE TABLE t(x INTEGER)");
    db.exec("INSERT INTO t VALUES (1)");
    assert.throws(
      () =>
        transaction(db, () => {
          db.exec("INSERT INTO t VALUES (2)");
          throw new Error("boom");
        }),
      /boom/,
    );
    const rows = db.prepare("SELECT x FROM t").all() as { x: number }[];
    assert.deepEqual(rows.map((r) => r.x), [1], "row 2 must be rolled back");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transaction returns the body's return value", () => {
  const dir = makeTempDir();
  try {
    const db: Database = openDatabase(join(dir, "test.db"));
    db.exec("CREATE TABLE t(x INTEGER)");
    const result = transaction(db, () => {
      db.exec("INSERT INTO t VALUES (42)");
      return (db.prepare("SELECT x FROM t").get() as { x: number }).x;
    });
    assert.equal(result, 42);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
