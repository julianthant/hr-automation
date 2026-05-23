import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { registerLocalFile, getRegisteredFile } from "../../../src/tracker/files/files.js";

function tmpTracker(): string {
  return mkdtempSync(join(tmpdir(), "file-reg-"));
}

test("registerLocalFile stores a stable fileId and metadata", () => {
  const dir = tmpTracker();
  try {
    const file = join(dir, "upload.pdf");
    writeFileSync(file, Buffer.from("%PDF-1.7\nfake\n"));
    const db = openStateDb(dir);
    const registered = registerLocalFile(db, {
      kind: "pdf",
      mimeType: "application/pdf",
      path: file,
      originalName: "upload.pdf",
      source: "upload",
      workflow: "ocr",
      itemId: "session-1",
      runId: "run-1",
    });
    assert.match(registered.fileId, /^[a-f0-9]{32}$/);
    const fetched = getRegisteredFile(db, registered.fileId);
    assert.equal(fetched?.originalName, "upload.pdf");
    assert.equal(fetched?.storagePath, file);
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
