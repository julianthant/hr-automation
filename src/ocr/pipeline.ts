/**
 * Schema-bound OCR pipeline. Splits the PDF into per-page PNGs and fans
 * pages across the multi-provider key pool. Returns per-page status so
 * callers can surface failed pages to operators for manual retry.
 *
 * No auto-fallback to whole-PDF — that path lives in `runOcrWholePdf`
 * and is only reachable via the operator-initiated escape-hatch
 * endpoint.
 */
import type { ZodType } from "zod/v4";
import { log } from "../utils/log.js";
import { ocrDocument, type OcrRequest, type OcrResult } from "./index.js";
import { renderPdfPagesToPngs } from "./render-pages.js";
import { runOcrPerPage } from "./per-page.js";
import { buildVisionPool, summarizePool, type PoolKey } from "./per-page-pool.js";

export interface OcrPipelineInput<T> {
  pdfPath: string;
  pageImagesDir: string;
  recordSchema: ZodType<T>;
  arraySchema: ZodType<T[]>;
  prompt: string;
  schemaName: string;
  /** Test escape: skip the actual pdf-to-img render. */
  _renderOverride?: (pdfPath: string, pageImagesDir: string) => Promise<string[]>;
  /** Test escape: inject a fake pool. */
  _poolOverride?: PoolKey[];
}

export interface OcrPipelineResult<T> {
  data: T[];
  provider: string;
  attempts: number;
  cached: boolean;
  pageImagesDir: string;
  pages: Array<{
    page: number;
    success: boolean;
    error?: string;
    attemptedKeys: string[];
    poolKeyId?: string;
  }>;
}

export async function runOcrPipeline<T>(
  input: OcrPipelineInput<T>,
): Promise<OcrPipelineResult<T>> {
  const render = input._renderOverride ?? renderPdfPagesToPngs;
  const pool = input._poolOverride ?? buildVisionPool();

  const pageFilenames = await render(input.pdfPath, input.pageImagesDir);
  if (pageFilenames.length === 0) {
    throw new Error(
      "PDF page render failed — re-upload or use Re-OCR whole PDF",
    );
  }
  if (pool.length === 0) {
    throw new Error(
      "no vision API keys configured (set GEMINI_API_KEY*, MISTRAL_API_KEY*, GROQ_API_KEY*, or SAMBANOVA_API_KEY*)",
    );
  }

  log.step(
    `[ocr] per-page: ${pageFilenames.length} page(s) across pool ${summarizePool(pool)}`,
  );
  const perPage = await runOcrPerPage({
    pageImagesDir: input.pageImagesDir,
    pagesAsImages: pageFilenames,
    prompt: input.prompt,
    schema: input.recordSchema,
    pool,
  });

  return {
    data: perPage.records,
    provider: `per-page (${perPage.poolSummary})`,
    attempts: perPage.pages.length,
    cached: false,
    pageImagesDir: input.pageImagesDir,
    pages: perPage.pages.map((p) => ({
      page: p.page,
      success: p.success,
      error: p.error,
      attemptedKeys: p.poolKeyId ? [p.poolKeyId] : [],
      poolKeyId: p.poolKeyId,
    })),
  };
}

/**
 * Operator-initiated whole-PDF escape hatch. Bypasses per-page entirely;
 * one cached Gemini call on the full PDF. Replaces records on the row.
 */
export async function runOcrWholePdf<T>(input: {
  pdfPath: string;
  arraySchema: ZodType<T[]>;
  prompt: string;
  schemaName: string;
  _override?: <U>(req: OcrRequest<U>) => Promise<OcrResult<U>>;
}): Promise<{ data: T[]; provider: string; attempts: number; cached: boolean }> {
  const fn = input._override ?? ocrDocument;
  const result = await fn({
    pdfPath: input.pdfPath,
    schema: input.arraySchema,
    prompt: input.prompt,
    schemaName: input.schemaName,
  });
  return {
    data: result.data,
    provider: result.provider,
    attempts: result.attempts,
    cached: result.cached,
  };
}
