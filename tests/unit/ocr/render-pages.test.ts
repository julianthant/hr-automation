import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderPdfPagesToPngs } from "../../../src/ocr/render-pages.js";

async function createOnePagePdf(dir: string): Promise<string> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const bytes = await doc.save();
  const out = path.join(dir, "test.pdf");
  fs.writeFileSync(out, bytes);
  return out;
}

test("renderPdfPagesToPngs returns one PNG file per page", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-test-"));
  const pdfPath = await createOnePagePdf(tmpDir);
  const outDir = path.join(tmpDir, "out");

  const filenames = await renderPdfPagesToPngs(pdfPath, outDir);

  assert.equal(filenames.length, 1, "expected one PNG for one-page PDF");
  assert.equal(filenames[0], "page-01.png");
  assert.ok(fs.existsSync(path.join(outDir, "page-01.png")));
  assert.ok(
    fs.statSync(path.join(outDir, "page-01.png")).size > 100,
    "PNG should be non-empty",
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("renderPdfPagesToPngs returns empty array on render failure", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-fail-test-"));
  const badPath = path.join(tmpDir, "not-a-pdf.pdf");
  fs.writeFileSync(badPath, "this is not a pdf");
  const outDir = path.join(tmpDir, "out");

  const filenames = await renderPdfPagesToPngs(badPath, outDir);
  assert.equal(filenames.length, 0, "expected empty array on render failure");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
