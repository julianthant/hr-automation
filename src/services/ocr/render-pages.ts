import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../../utils/log.js";

/** Benign pdfjs stderr when opening valid PDFs built with pdf-lib. */
const PDFJS_INDEXING_WARNING = "Warning: Indexing all PDF objects";

function withSuppressedPdfjsIndexingWarning<T>(fn: () => Promise<T>): Promise<T> {
  const prevWarn = console.warn;
  const prevWrite = process.stderr.write.bind(process.stderr);
  console.warn = (...args: unknown[]) => {
    const msg = args.map(String).join(" ");
    if (msg.includes(PDFJS_INDEXING_WARNING)) return;
    prevWarn(...args);
  };
  process.stderr.write = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean => {
    const encoding =
      typeof encodingOrCb === "string" ? encodingOrCb : "utf8";
    const text =
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(encoding);
    if (!text.includes(PDFJS_INDEXING_WARNING)) {
      return prevWrite(chunk, encodingOrCb as never, cb as never);
    }
    if (typeof encodingOrCb === "function") encodingOrCb();
    else if (cb) cb();
    return true;
  });
  return fn().finally(() => {
    console.warn = prevWarn;
    process.stderr.write = prevWrite;
  });
}

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
  opts: { pad?: number } = {},
): Promise<string[]> {
  try {
    const pad = opts.pad ?? 2;
    await fs.mkdir(outDir, { recursive: true });
    const pdfBuffer = await fs.readFile(pdfPath);
    return await withSuppressedPdfjsIndexingWarning(async () => {
      const { pdf } = await import("pdf-to-img");
      // Render review previews at a higher scale so operators can manually
      // verify handwriting and small printed labels without opening the PDF
      // separately.
      const document = await pdf(pdfBuffer, { scale: 1.5 });
      // Collect all rendered images first (iterator is serial — required by pdf-to-img),
      // then flush all writes in parallel via Promise.all (saves ~4s on a 20-page PDF).
      const pages: Array<{ name: string; data: Uint8Array }> = [];
      let i = 1;
      for await (const image of document) {
        pages.push({ name: `page-${String(i).padStart(pad, "0")}.png`, data: image });
        i += 1;
      }
      await Promise.all(
        pages.map(({ name, data }) => fs.writeFile(path.join(outDir, name), data)),
      );
      return pages.map((p) => p.name);
    });
  } catch (err) {
    log.warn(
      `renderPdfPagesToPngs failed for ${pdfPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
