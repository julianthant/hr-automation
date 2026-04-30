import fs from "node:fs/promises";
import path from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ZodType } from "zod/v4";
import { log } from "../utils/log.js";

export interface PerPageOcrRequest<T> {
  /** PNG filenames inside `pageImagesDir`, 1-indexed by page (e.g. page-01.png). */
  pagesAsImages: string[];
  pageImagesDir: string;
  /** Workflow-specific OCR prompt. */
  prompt: string;
  /**
   * Schema validating one record. The function returns Array<T>; each
   * page's records are concatenated in source-page order.
   */
  schema: ZodType<T>;
}

export interface PerPageOcrResult<T> {
  records: Array<T & { sourcePage: number }>;
  /** Per-page status, ordered by page number (1-indexed at element 0). */
  pages: Array<{
    page: number;
    success: boolean;
    error?: string;
    keyIndex?: number;
  }>;
}

/** @internal — test escape hatch. */
type CallSinglePageFn = (args: {
  imagePath: string;
  prompt: string;
  pageNum: number;
}) => Promise<{ json: unknown; keyIndex: number }>;

let _callSinglePageForTests: CallSinglePageFn | undefined;

export function __setPerPageCallForTests(fn: CallSinglePageFn | undefined): void {
  _callSinglePageForTests = fn;
}

function getGeminiKeys(): string[] {
  const keys: string[] = [];
  for (const name of [
    "GEMINI_API_KEY",
    "GEMINI_API_KEY2",
    "GEMINI_API_KEY3",
    "GEMINI_API_KEY4",
    "GEMINI_API_KEY5",
    "GEMINI_API_KEY6",
  ]) {
    const v = process.env[name];
    if (v && v.trim()) keys.push(v.trim());
  }
  return keys;
}

/**
 * Run OCR on each pre-rendered page image in parallel, preserving page
 * order in the output. Returns the merged records array (sorted by
 * sourcePage) plus a per-page status array.
 *
 * Concurrency is capped at `OCR_PAGE_CONCURRENCY` (default 4) to respect
 * provider rate limits. A page that fails (network, rate-limit, parse
 * error) records `success: false` and is omitted from the merged
 * records — the caller decides whether to retry, skip, or fail.
 *
 * Not wired into the prep orchestrator yet (the existing whole-PDF
 * `ocrDocument` is still used for stage-2 OCR). Provided as the
 * future-resilience path: when one provider key is rate-limited mid-batch
 * we want the other pages to succeed without re-OCRing the entire PDF.
 */
export async function runOcrPerPage<T>(
  req: PerPageOcrRequest<T>,
): Promise<PerPageOcrResult<T>> {
  const concurrency = Math.max(
    1,
    Number.parseInt(process.env.OCR_PAGE_CONCURRENCY ?? "4", 10) || 4,
  );

  const tasks = req.pagesAsImages.map((filename, idx) => ({
    pageNum: idx + 1,
    imagePath: path.join(req.pageImagesDir, filename),
  }));

  const results: Array<{ page: number; success: boolean; error?: string; keyIndex?: number; records?: unknown[] }> =
    new Array(tasks.length);

  const limit = makeLimiter(concurrency);
  await Promise.all(
    tasks.map((t) =>
      limit(async () => {
        try {
          const { json, keyIndex } = await callSinglePage({
            imagePath: t.imagePath,
            prompt: req.prompt,
            pageNum: t.pageNum,
          });
          const arr = Array.isArray(json) ? json : [json];
          results[t.pageNum - 1] = {
            page: t.pageNum,
            success: true,
            keyIndex,
            records: arr,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`runOcrPerPage page ${t.pageNum} failed: ${msg}`);
          results[t.pageNum - 1] = { page: t.pageNum, success: false, error: msg };
        }
      }),
    ),
  );

  const records: Array<T & { sourcePage: number }> = [];
  for (const r of results) {
    if (!r.success || !r.records) continue;
    for (const rec of r.records) {
      const parsed = req.schema.safeParse(rec);
      if (!parsed.success) continue;
      records.push({ ...(parsed.data as T), sourcePage: r.page });
    }
  }
  return {
    records,
    pages: results.map((r) => ({
      page: r.page,
      success: r.success,
      error: r.error,
      keyIndex: r.keyIndex,
    })),
  };
}

async function callSinglePage(args: {
  imagePath: string;
  prompt: string;
  pageNum: number;
}): Promise<{ json: unknown; keyIndex: number }> {
  if (_callSinglePageForTests) return _callSinglePageForTests(args);
  const keys = getGeminiKeys();
  if (keys.length === 0) {
    throw new Error("runOcrPerPage: no GEMINI_API_KEY* configured");
  }
  const png = await fs.readFile(args.imagePath);
  let lastError: unknown;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      const genai = new GoogleGenerativeAI(key);
      const model = genai.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: { responseMimeType: "application/json" },
      });
      const raw = (await model.generateContent([
        { text: args.prompt },
        {
          inlineData: {
            mimeType: "image/png",
            data: png.toString("base64"),
          },
        },
      ])) as { response: { text(): string } };
      const text = raw.response.text();
      return { json: JSON.parse(text), keyIndex: i + 1 };
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/401|unauthor|invalid\s*api\s*key/i.test(msg)) break;
    }
  }
  throw lastError ?? new Error("runOcrPerPage: all keys failed");
}

function makeLimiter(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active += 1;
        fn().then(
          (val) => {
            active -= 1;
            const next = queue.shift();
            if (next) next();
            resolve(val);
          },
          (err) => {
            active -= 1;
            const next = queue.shift();
            if (next) next();
            reject(err);
          },
        );
      };
      if (active < n) run();
      else queue.push(run);
    });
}
