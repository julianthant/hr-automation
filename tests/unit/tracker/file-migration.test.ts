import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../src/infra/sqlite/index.js";
import { getRegisteredFile } from "../../../src/tracker/files/files.js";
import {
  closeStateDbForTests,
  openStateDb,
  stateDbPath,
} from "../../../src/tracker/state/db.js";
import { MIGRATIONS } from "../../../src/tracker/state/schema.js";

let dir: string;

function createV21Db(): ReturnType<typeof openDatabase> {
  const db = openDatabase(stateDbPath(dir));
  for (const migration of MIGRATIONS) {
    if (migration.version > 21) break;
    db.exec(migration.sql);
    db.prepare(`
      INSERT INTO schema_version (id, version, applied_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at
    `).run(migration.version, new Date().toISOString());
  }
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "file-v21-migration-"));
});

afterEach(() => {
  closeStateDbForTests(dir);
  rmSync(dir, { recursive: true, force: true });
});

describe("v21 file registry migration", () => {
  it("backfills a legacy hash id while preserving its existing URL identity", () => {
    const path = join(dir, "legacy.pdf");
    const bytes = Buffer.from("%PDF legacy migration");
    writeFileSync(path, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const legacyId = sha.slice(0, 32);
    const old = createV21Db();
    old.prepare(`
      INSERT INTO files (
        file_id, kind, mime_type, original_name, storage_path, sha256, bytes,
        source, created_at
      ) VALUES (?, 'pdf', 'application/pdf', 'legacy.pdf', ?, ?, ?, 'legacy', ?)
    `).run(legacyId, path, sha, bytes.length, new Date().toISOString());
    old.close();

    const migrated = openStateDb(dir);
    expect(getRegisteredFile(migrated, legacyId)).toMatchObject({
      fileId: legacyId,
      storagePath: path,
      sha256: sha,
    });
    expect(migrated.prepare("SELECT blob_id, attachment_key FROM files").get())
      .toEqual({ blob_id: sha, attachment_key: `legacy:${legacyId}` });
  });

  it("fails migration when one hash claims conflicting byte sizes", () => {
    const old = createV21Db();
    const sha = "f".repeat(64);
    const now = new Date().toISOString();
    const insert = old.prepare(`
      INSERT INTO files (
        file_id, kind, mime_type, original_name, storage_path, sha256, bytes,
        source, created_at
      ) VALUES (?, 'pdf', 'application/pdf', ?, ?, ?, ?, 'legacy', ?)
    `);
    insert.run("a".repeat(32), "a.pdf", join(dir, "a.pdf"), sha, 10, now);
    insert.run("b".repeat(32), "b.pdf", join(dir, "b.pdf"), sha, 11, now);
    old.close();

    expect(() => openStateDb(dir)).toThrow();
  });
});
