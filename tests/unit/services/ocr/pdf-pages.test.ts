import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { mergePdfs, extractPdfPage } from "../../../../src/services/ocr/pdf-pages.js";

async function makePdf(path: string, pageCount: number): Promise<void> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([200, 200]);
  writeFileSync(path, await doc.save());
}

async function pageCountOf(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

describe("mergePdfs", () => {
  it("concatenates pages from multiple PDFs preserving order", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "onbase-pdf-"));
    t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const a = join(dir, "a.pdf");
    const b = join(dir, "b.pdf");
    await makePdf(a, 2);
    await makePdf(b, 3);
    const merged = await mergePdfs([a, b]);
    assert.equal(await pageCountOf(merged), 5);
  });

  it("throws when no source PDFs are provided", async () => {
    await assert.rejects(() => mergePdfs([]), /no source PDFs/);
  });
});

describe("extractPdfPage", () => {
  it("extracts a single page as a one-page PDF", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "onbase-pdf-"));
    t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const src = join(dir, "src.pdf");
    await makePdf(src, 4);
    const page2 = await extractPdfPage(src, 2);
    assert.equal(await pageCountOf(page2), 1);
  });

  it("throws for an out-of-range page number (1-based)", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "onbase-pdf-"));
    t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const src = join(dir, "src.pdf");
    await makePdf(src, 2);
    await assert.rejects(() => extractPdfPage(src, 5), /out of range/);
    await assert.rejects(() => extractPdfPage(src, 0), /out of range/);
  });
});
