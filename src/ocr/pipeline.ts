/**
 * Schema-bound OCR pipeline. Prefers parallel per-page processing across
 * the multi-provider key pool when a PDF can be split into page PNGs and
 * at least one provider key is configured; falls back to whole-PDF
 * `ocrDocument` (the cached, single-Gemini-key path) otherwise.
 *
 * The contract matches `ocrDocument`'s `OcrResult<T[]>` shape so the
 * existing callers in `prepare.ts` don't need to branch — they get a
 * uniform `{ data: T[], provider, attempts, cached }` regardless of
 * which path ran.
 */
import type { ZodType } from "zod/v4";
import { log } from "../utils/log.js";
import { ocrDocument, type OcrRequest, type OcrResult } from "./index.js";
import { renderPdfPagesToPngs } from "./render-pages.js";
import { runOcrPerPage } from "./per-page.js";
import { buildVisionPool, summarizePool } from "./per-page-pool.js";

export interface OcrPipelineInput<T> {
  pdfPath: string;
  /** Where to render per-page PNGs (best-effort — empty if render fails). */
  pageImagesDir: string;
  /** Single-record schema (for per-page path). */
  recordSchema: ZodType<T>;
  /** Array schema = `z.array(recordSchema)` (for whole-PDF fallback path). */
  arraySchema: ZodType<T[]>;
  /** OCR prompt — same content sent to every provider. */
  prompt: string;
  /** Cache key + prompt label for the whole-PDF fallback. */
  schemaName: string;
  /**
   * If set, bypass per-page entirely and call this fn (the existing
   * `_ocrFn` test escape hatch). Production callers leave it undefined.
   */
  ocrFnOverride?: <U>(req: OcrRequest<U>) => Promise<OcrResult<U>>;
}

export interface OcrPipelineResult<T> {
  data: T[];
  provider: string;
  attempts: number;
  cached: boolean;
  /**
   * Where pre-rendered page PNGs live (empty string if rendering
   * failed or the fallback path was used). Callers persist this on
   * the prep row's `data.pageImagesDir` so the dashboard can build
   * `/api/prep/pdf-page` URLs.
   */
  pageImagesDir: string;
}

/**
 * The threshold below which the per-page path bails out to whole-PDF.
 * Set to 50% — if half the pages failed across the rotation, something
 * is wrong with the pool or the PDF and the whole-PDF path is more
 * likely to recover (single Gemini call with the full document context).
 */
const MIN_PER_PAGE_SUCCESS_RATIO = 0.5;

/**
 * Run OCR on a PDF, returning a unified `data: T[]` record list.
 *
 * Behaviour:
 *   1. If `ocrFnOverride` is set (test escape hatch), call it directly
 *      and return — pages are NOT rendered, and per-page is skipped.
 *   2. Render `pdfPath` to per-page PNGs in `pageImagesDir`. Best-effort —
 *      render failure surfaces as `pageImagesDir: ""` and we fall through.
 *   3. If at least one page rendered AND the multi-provider pool is
 *      non-empty, run `runOcrPerPage`. Accept the result if at least
 *      half the pages succeeded.
 *   4. Otherwise, fall back to `ocrDocument` (cached, single-Gemini path).
 *
 * The page-images dir is preserved across both OCR paths so the
 * dashboard can show PDF previews regardless of which path won.
 */
export async function runOcrPipeline<T>(
  input: OcrPipelineInput<T>,
): Promise<OcrPipelineResult<T>> {
  // 1. Test override — bypass everything else.
  if (input.ocrFnOverride) {
    const r = await input.ocrFnOverride({
      pdfPath: input.pdfPath,
      schema: input.arraySchema,
      prompt: input.prompt,
      schemaName: input.schemaName,
    });
    return {
      data: r.data,
      provider: r.provider,
      attempts: r.attempts,
      cached: r.cached,
      pageImagesDir: "",
    };
  }

  // 2. Render pages (best-effort).
  const pageFilenames = await renderPdfPagesToPngs(
    input.pdfPath,
    input.pageImagesDir,
  );
  const pageImagesDir = pageFilenames.length > 0 ? input.pageImagesDir : "";

  // 3. Try per-page if pages rendered + pool non-empty.
  if (pageFilenames.length > 0) {
    const pool = buildVisionPool();
    if (pool.length > 0) {
      log.step(
        `[ocr] per-page: ${pageFilenames.length} page(s) across pool ${summarizePool(pool)}`,
      );
      try {
        const perPage = await runOcrPerPage({
          pageImagesDir: input.pageImagesDir,
          pagesAsImages: pageFilenames,
          prompt: input.prompt,
          schema: input.recordSchema,
          pool,
        });
        const successCount = perPage.pages.filter((p) => p.success).length;
        const totalPages = perPage.pages.length;
        const ratio = totalPages > 0 ? successCount / totalPages : 0;
        if (ratio >= MIN_PER_PAGE_SUCCESS_RATIO && perPage.records.length > 0) {
          log.step(
            `[ocr] per-page accepted: ${successCount}/${totalPages} page(s) ok, ${perPage.records.length} record(s)`,
          );
          return {
            data: perPage.records,
            provider: `per-page (${perPage.poolSummary})`,
            attempts: totalPages,
            cached: false,
            pageImagesDir,
          };
        }
        log.warn(
          `[ocr] per-page low success ratio (${successCount}/${totalPages}); falling back to whole-PDF`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[ocr] per-page threw: ${msg} — falling back to whole-PDF`);
      }
    } else {
      log.step(
        "[ocr] per-page skipped — no vision API keys configured (set GEMINI_API_KEY*, MISTRAL_API_KEY*, GROQ_API_KEY*, or SAMBANOVA_API_KEY*)",
      );
    }
  }

  // 4. Fallback: whole-PDF via ocrDocument (cached single-Gemini call).
  const r = await ocrDocument({
    pdfPath: input.pdfPath,
    schema: input.arraySchema,
    prompt: input.prompt,
    schemaName: input.schemaName,
  });
  return {
    data: r.data,
    provider: r.provider,
    attempts: r.attempts,
    cached: r.cached,
    pageImagesDir,
  };
}
