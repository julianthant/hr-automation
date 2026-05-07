import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { registerLocalFile } from "../../../src/tracker/files/files.js";
import { ensurePdfPageCache, getCachedPage } from "../../../src/tracker/files/pdf-cache.js";

test("ensurePdfPageCache renders page rows and reuses cache hits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdf-cache-"));
  try {
    const pdfPath = join(dir, "fake.pdf");
    writeFileSync(pdfPath, "%PDF fake");
    const db = openStateDb(dir);
    const file = registerLocalFile(db, {
      kind: "pdf",
      mimeType: "application/pdf",
      path: pdfPath,
      originalName: "fake.pdf",
      source: "upload",
    });
    const calls: string[][] = [];
    await ensurePdfPageCache(db, {
      trackerDir: dir,
      fileId: file.fileId,
      pdfPath,
      render: async (_path, outDir) => {
        calls.push([_path, outDir]);
        writeFileSync(join(outDir, "page-001.png"), "png");
        return ["page-001.png"];
      },
    });
    await ensurePdfPageCache(db, {
      trackerDir: dir,
      fileId: file.fileId,
      pdfPath,
      render: async () => {
        throw new Error("should not render twice");
      },
    });
    assert.equal(calls.length, 1);
    const page = getCachedPage(db, file.fileId, 1);
    assert.equal(page?.status, "ready");
    assert.ok(page?.imagePath);
    assert.equal(existsSync(page.imagePath), true);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensurePdfPageCache dedupes concurrent renders for the same file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdf-cache-race-"));
  try {
    const pdfPath = join(dir, "fake.pdf");
    writeFileSync(pdfPath, "%PDF fake");
    const db = openStateDb(dir);
    const file = registerLocalFile(db, {
      kind: "pdf",
      mimeType: "application/pdf",
      path: pdfPath,
      originalName: "fake.pdf",
      source: "upload",
    });
    let calls = 0;
    const render = async (_path: string, outDir: string) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      writeFileSync(join(outDir, "page-001.png"), "png");
      return ["page-001.png"];
    };

    const [a, b] = await Promise.all([
      ensurePdfPageCache(db, { trackerDir: dir, fileId: file.fileId, pdfPath, render }),
      ensurePdfPageCache(db, { trackerDir: dir, fileId: file.fileId, pdfPath, render }),
    ]);

    assert.equal(calls, 1);
    assert.equal(a[0].imagePath, b[0].imagePath);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
