import { test } from "vitest";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderPdfPagesToPngs } from "../../../../src/services/ocr/render-pages.js";
import { writeOnePagePdf } from "../../../_utils/one-page-pdf.js";

test("renderPdfPagesToPngs returns one PNG file per page", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-test-"));
  const pdfPath = path.join(tmpDir, "test.pdf");
  await writeOnePagePdf(pdfPath);
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
