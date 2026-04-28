import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { PDFDocument } from "pdf-lib";

/**
 * Bundle a list of image files into a single PDF, one page per image.
 * Supports JPEG and PNG (the formats pdf-lib accepts directly). Other
 * formats should be converted by the caller before calling this.
 *
 * Creates the output's parent directory if missing.
 */
export async function bundlePhotosToPdf(
  imagePaths: string[],
  outPath: string,
): Promise<void> {
  mkdirSync(dirname(outPath), { recursive: true });
  const doc = await PDFDocument.create();

  for (const p of imagePaths) {
    const bytes = readFileSync(p);
    const ext = extname(p).toLowerCase();
    let img;
    if (ext === ".jpg" || ext === ".jpeg") {
      img = await doc.embedJpg(bytes);
    } else if (ext === ".png") {
      img = await doc.embedPng(bytes);
    } else {
      // Default to JPEG since most phone cameras produce JPEG; pdf-lib
      // throws a clear error if the bytes don't match. Caller should
      // pre-normalize HEIC etc. on the mobile side.
      img = await doc.embedJpg(bytes);
    }
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }

  // Empty case: add a blank page so the PDF is structurally valid.
  if (imagePaths.length === 0) {
    doc.addPage();
  }

  const pdfBytes = await doc.save();
  writeFileSync(outPath, pdfBytes);
}
