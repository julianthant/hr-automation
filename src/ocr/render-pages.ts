import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../utils/log.js";

/**
 * Render each page of a PDF to a PNG file.
 * Files are named `page-NN.png` (1-indexed, zero-padded to 2 digits).
 *
 * On any failure (corrupt PDF, library error, OOM), logs a warning and
 * returns an empty array. Callers should treat that as "no preview
 * available" and continue — preview rendering is not load-bearing.
 */
export async function renderPdfPagesToPngs(
  pdfPath: string,
  outDir: string,
): Promise<string[]> {
  try {
    await fs.mkdir(outDir, { recursive: true });
    const pdfBuffer = await fs.readFile(pdfPath);
    const { pdf } = await import("pdf-to-img");
    // scale=1.0 gives ~310KB PNGs (vs ~697KB at 1.5x) — ~2.3x faster to
     // serve + decode in the browser. Operator-side OCR review can still
     // read the page; the LLM extraction was already going to handwriting-
     // accuracy limits at 1.5x.
    const document = await pdf(pdfBuffer, { scale: 1.0 });
    const filenames: string[] = [];
    let i = 1;
    for await (const image of document) {
      const name = `page-${String(i).padStart(2, "0")}.png`;
      await fs.writeFile(path.join(outDir, name), image);
      filenames.push(name);
      i += 1;
    }
    return filenames;
  } catch (err) {
    log.warn(
      `renderPdfPagesToPngs failed for ${pdfPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
