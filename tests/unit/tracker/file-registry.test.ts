import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { registerLocalFile, getRegisteredFile } from "../../../src/tracker/files/files.js";

function tmpTracker(): string {
  return mkdtempSync(join(tmpdir(), "file-reg-"));
}

test("registerLocalFile stores an idempotent UUID attachment and metadata", () => {
  const dir = tmpTracker();
  try {
    const file = join(dir, "upload.pdf");
    writeFileSync(file, Buffer.from("%PDF-1.7\nfake\n"));
    const db = openStateDb(dir);
    const registered = registerLocalFile(db, {
      trackerDir: dir,
      kind: "pdf",
      mimeType: "application/pdf",
      path: file,
      originalName: "upload.pdf",
      source: "upload",
      workflow: "ocr",
      itemId: "session-1",
      runId: "run-1",
    });
    assert.match(registered.fileId, /^[a-f0-9-]{36}$/);
    const fetched = getRegisteredFile(db, registered.fileId);
    assert.equal(fetched?.originalName, "upload.pdf");
    assert.notEqual(fetched?.storagePath, file);
    writeFileSync(file, "source path was overwritten");
    assert.equal(readFileSync(getRegisteredFile(db, registered.fileId)!.storagePath, "utf8"), "%PDF-1.7\nfake\n");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("identical bytes can belong to separate runs without overwriting ownership", () => {
  const dir = tmpTracker();
  try {
    const aPath = join(dir, "a.pdf");
    const bPath = join(dir, "b.pdf");
    writeFileSync(aPath, Buffer.from("%PDF-1.7\nsame\n"));
    writeFileSync(bPath, Buffer.from("%PDF-1.7\nsame\n"));
    const db = openStateDb(dir);
    const a = registerLocalFile(db, {
      trackerDir: dir,
      kind: "pdf",
      mimeType: "application/pdf",
      path: aPath,
      originalName: "a.pdf",
      source: "upload",
      workflow: "ocr",
      itemId: "session-a",
      runId: "run-a",
    });
    const b = registerLocalFile(db, {
      trackerDir: dir,
      kind: "pdf",
      mimeType: "application/pdf",
      path: bPath,
      originalName: "b.pdf",
      source: "upload",
      workflow: "ocr",
      itemId: "session-b",
      runId: "run-b",
    });

    assert.notEqual(a.fileId, b.fileId);
    assert.equal(a.sha256, b.sha256);
    assert.equal(getRegisteredFile(db, a.fileId)?.runId, "run-a");
    assert.equal(getRegisteredFile(db, b.fileId)?.runId, "run-b");
    const blobs = db.prepare("SELECT COUNT(*) AS n FROM file_blobs").get() as { n: number };
    assert.equal(blobs.n, 1);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy hash attachment ids remain readable after migration", () => {
  const dir = tmpTracker();
  try {
    const file = join(dir, "legacy.pdf");
    writeFileSync(file, Buffer.from("%PDF legacy"));
    const db = openStateDb(dir);
    const legacyId = "a".repeat(32);
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    db.prepare(`
      INSERT INTO file_blobs (blob_id, sha256, bytes, storage_path, created_at)
      VALUES (?, ?, 11, NULL, ?)
    `).run(sha256, sha256, new Date().toISOString());
    db.prepare(`
      INSERT INTO files (
        file_id, kind, mime_type, original_name, storage_path, sha256, bytes,
        source, created_at, blob_id, attachment_key
      ) VALUES (?, 'pdf', 'application/pdf', 'legacy.pdf', ?, ?, 11,
        'legacy', ?, ?, ?)
    `).run(legacyId, file, sha256, new Date().toISOString(), sha256, `legacy:${legacyId}`);
    assert.equal(getRegisteredFile(db, legacyId)?.originalName, "legacy.pdf");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getRegisteredFile rejects unknown file ids without path access", () => {
  const dir = tmpTracker();
  try {
    const db = openStateDb(dir);
    assert.equal(getRegisteredFile(db, "../etc/passwd"), null);
    assert.equal(getRegisteredFile(db, "missing"), null);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
