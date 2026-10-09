import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";

/**
 * PDF page utilities for the OnBase upload flow.
 *
 * OnBase imports one document per person, and each page of an uploaded PDF maps
 * to one person. So the operator may upload many PDFs which are first MERGED
 * into one combined PDF (page order preserved), the combined PDF is OCR'd
 * page-by-page, and at import time each person's page is SPLIT back out as a
 * single-page PDF to feed OnBase's file picker.
 */

/**
 * Merge multiple source PDFs into one combined PDF, preserving page order.
 * Returns the combined PDF bytes. Each source page becomes one page of the
 * output (one person per page).
 */
export async function mergePdfs(sourcePaths: string[]): Promise<Uint8Array> {
  if (sourcePaths.length === 0) {
    throw new Error("mergePdfs: no source PDFs provided");
  }
  const merged = await PDFDocument.create();
  for (const sourcePath of sourcePaths) {
    const bytes = readFileSync(sourcePath);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const copied = await merged.copyPages(src, src.getPageIndices());
    for (const page of copied) merged.addPage(page);
  }
  return merged.save();
}

/**
 * Extract a single page (1-based `pageNumber`) from a PDF on disk as a
 * standalone single-page PDF. Returns the new PDF bytes. Throws if the page
 * number is out of range.
 */
export async function extractPdfPage(
  srcPath: string,
  pageNumber: number,
): Promise<Uint8Array> {
  const bytes = readFileSync(srcPath);
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pageCount = src.getPageCount();
  if (pageNumber < 1 || pageNumber > pageCount) {
    throw new Error(
      `extractPdfPage: page ${pageNumber} out of range (PDF has ${pageCount} page(s)) for ${srcPath}`,
    );
  }
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(src, [pageNumber - 1]);
  out.addPage(page);
  return out.save();
}
