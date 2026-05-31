import fs from "node:fs/promises";
import path from "node:path";

/**
 * Write a minimal valid one-page PDF (pdf-lib). Use in tests instead of
 * hand-written %PDF stubs — those trigger pdf-to-img "Indexing all PDF
 * objects" warnings and pre-render zero pages.
 */
export async function writeOnePagePdf(filePath: string): Promise<void> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const bytes = await doc.save();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
}
