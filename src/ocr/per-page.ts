import path from "node:path";
import type { ZodType } from "zod/v4";
import { log } from "../utils/log.js";
import { buildVisionPool, summarizePool, type PoolKey } from "./per-page-pool.js";

export interface PerPageOcrRequest<T> {
  /** PNG filenames inside `pageImagesDir`, 1-indexed by page (e.g. page-01.png). */
  pagesAsImages: string[];
  pageImagesDir: string;
  /** Workflow-specific OCR prompt. */
  prompt: string;
  /**
   * Schema validating one record (the per-page response is expected to
   * be an array of records — typically one per form on the page).
   * Records that fail validation are dropped with a warn log.
   */
  schema: ZodType<T>;
  /**
   * Override the pool — used by tests to inject a fake pool that
   * doesn't hit the network. Defaults to `buildVisionPool()`.
   */
  pool?: PoolKey[];
}

export interface PerPageOcrResult<T> {
  records: Array<T & { sourcePage: number }>;
  /** Per-page status, ordered by page number (1-indexed at element 0). */
  pages: Array<{
    page: number;
    success: boolean;
    error?: string;
    /** Pool entry id that succeeded (or the last one tried on failure). */
    poolKeyId?: string;
  }>;
  /** Compact pool summary (e.g. `"gemini=6 mistral=2 groq=7"`) for logging. */
  poolSummary: string;
}

/** @internal — test escape hatch. Bypasses the pool entirely. */
type CallSinglePageFn = (args: {
  imagePath: string;
  prompt: string;
  pageNum: number;
}) => Promise<{ json: unknown; poolKeyId: string }>;

let _callSinglePageForTests: CallSinglePageFn | undefined;

export function __setPerPageCallForTests(fn: CallSinglePageFn | undefined): void {
  _callSinglePageForTests = fn;
}

/**
 * OCR every page of a pre-rendered PDF in parallel using the multi-
 * provider key pool. Returns the merged records array (sorted by
 * sourcePage) plus a per-page status array.
 *
 * Concurrency = `min(pool.length, OCR_PAGE_CONCURRENCY ?? pool.length)`.
 * Each page is initially assigned to `pool[i % pool.length]`; on
 * failure that page walks through the rest of the pool (up to
 * `OCR_PER_PAGE_MAX_RETRIES` other keys, default 2) before giving up.
 *
 * Pages that fail completely surface as `success: false` with the
 * last error message and are omitted from `records`. The caller
 * decides whether to fall back to whole-PDF OCR or surface the
 * partial result.
 */
export async function runOcrPerPage<T>(
  req: PerPageOcrRequest<T>,
): Promise<PerPageOcrResult<T>> {
  const pool = req.pool ?? buildVisionPool();
  const poolSummary = summarizePool(pool);
  if (pool.length === 0 && !_callSinglePageForTests) {
    throw new Error(
      "runOcrPerPage: no vision API keys configured (set GEMINI_API_KEY*, MISTRAL_API_KEY*, GROQ_API_KEY*, or SAMBANOVA_API_KEY*)",
    );
  }

  const concurrencyEnv = Number.parseInt(process.env.OCR_PAGE_CONCURRENCY ?? "", 10);
  // Default concurrency = pool size (when running real keys) or 4 (the
  // legacy default that pre-dated the multi-provider pool — preserved
  // for tests that swap in `_callSinglePageForTests` and don't care
  // about real pool semantics). Env-override clamps to a sane upper
  // bound so OCR_PAGE_CONCURRENCY=999 doesn't melt anything.
  const fallbackConcurrency = pool.length > 0 ? pool.length : 4;
  const concurrency = Math.max(
    1,
    Number.isFinite(concurrencyEnv) && concurrencyEnv > 0
      ? Math.min(concurrencyEnv, Math.max(fallbackConcurrency, 1))
      : fallbackConcurrency,
  );

  const maxRetriesEnv = Number.parseInt(
    process.env.OCR_PER_PAGE_MAX_RETRIES ?? "",
    10,
  );
  const maxRetries = Number.isFinite(maxRetriesEnv) && maxRetriesEnv >= 0 ? maxRetriesEnv : 2;

  const tasks = req.pagesAsImages.map((filename, idx) => ({
    pageNum: idx + 1,
    imagePath: path.join(req.pageImagesDir, filename),
  }));

  type PageOutcome = {
    page: number;
    success: boolean;
    error?: string;
    poolKeyId?: string;
    rawRecords?: unknown[];
  };
  const results: PageOutcome[] = new Array(tasks.length);

  const limit = makeLimiter(concurrency);
  await Promise.all(
    tasks.map((t) =>
      limit(async () => {
        const initialIdx = pool.length > 0 ? (t.pageNum - 1) % pool.length : 0;
        // Build the try-order: initial key first, then `maxRetries` more
        // keys round-robin starting from the next slot. Avoids re-trying
        // the same provider key twice.
        const tryOrder: PoolKey[] = [];
        for (let r = 0; r <= maxRetries && r < pool.length; r++) {
          tryOrder.push(pool[(initialIdx + r) % pool.length]);
        }

        let lastError: unknown;
        let lastPoolKeyId: string | undefined;
        for (const k of tryOrder.length > 0 ? tryOrder : [null]) {
          try {
            const { json, poolKeyId } = await callSinglePage({
              imagePath: t.imagePath,
              prompt: req.prompt,
              pageNum: t.pageNum,
              key: k,
            });
            const arr = Array.isArray(json) ? (json as unknown[]) : [json];
            results[t.pageNum - 1] = {
              page: t.pageNum,
              success: true,
              poolKeyId,
              rawRecords: arr,
            };
            return;
          } catch (err) {
            lastError = err;
            lastPoolKeyId = k?.id;
            const msg = err instanceof Error ? err.message : String(err);
            // Don't retry on auth errors — that key is dead for this run.
            // The next key in tryOrder may still be valid.
            if (/401|invalid\s*api\s*key|unauthor/i.test(msg)) continue;
            // For 429 / quota / network, also continue to next key.
            // Anything else: also try the next key — best-effort.
          }
        }

        const errMsg =
          lastError instanceof Error ? lastError.message : String(lastError);
        log.warn(
          `runOcrPerPage page ${t.pageNum} failed after ${tryOrder.length} attempt(s): ${errMsg}`,
        );
        results[t.pageNum - 1] = {
          page: t.pageNum,
          success: false,
          error: errMsg,
          poolKeyId: lastPoolKeyId,
        };
      }),
    ),
  );

  // Schema-validate each record from each successful page; drop invalids.
  // Three fields are injected before `safeParse`:
  //   - rowIndex (default = array index): sign-in sheets have many rows; LLM
  //     occasionally drops the field on single-record pages
  //   - employeeSigned (default = true): worst case operator deselects in the
  //     preview pane
  //   - sourcePage (runner-authoritative): the LLM sees one page at a time
  //     and has no concept of absolute page number; we override whatever it
  //     sent so r.page is always the source of truth
  // Spread order: defaults first, LLM record next (overwrites the defaults
  // for rowIndex/employeeSigned), sourcePage last (always wins). Schemas
  // that don't declare these fields silently strip them via Zod's default
  // object behavior.
  const records: Array<T & { sourcePage: number }> = [];
  for (const r of results) {
    if (!r.success || !r.rawRecords) continue;
    for (const [idx, rec] of r.rawRecords.entries()) {
      const withInjects =
        rec && typeof rec === "object"
          ? {
              rowIndex: idx,
              employeeSigned: true,
              ...(rec as Record<string, unknown>),
              sourcePage: r.page,
            }
          : rec;
      const parsed = req.schema.safeParse(withInjects);
      if (!parsed.success) {
        log.warn(
          `runOcrPerPage page ${r.page} record dropped (schema): ${parsed.error.issues
            .slice(0, 1)
            .map((i) => i.message)
            .join("; ")}`,
        );
        continue;
      }
      records.push({ ...(parsed.data as T), sourcePage: r.page });
    }
  }

  return {
    records,
    pages: results.map((r) => ({
      page: r.page,
      success: r.success,
      error: r.error,
      poolKeyId: r.poolKeyId,
    })),
    poolSummary,
  };
}

async function callSinglePage(args: {
  imagePath: string;
  prompt: string;
  pageNum: number;
  key: PoolKey | null;
}): Promise<{ json: unknown; poolKeyId: string }> {
  if (_callSinglePageForTests) {
    return _callSinglePageForTests({
      imagePath: args.imagePath,
      prompt: args.prompt,
      pageNum: args.pageNum,
    });
  }
  if (!args.key) {
    throw new Error("runOcrPerPage: no pool key available");
  }
  const json = await args.key.callOcr(args.imagePath, args.prompt);
  return { json, poolKeyId: args.key.id };
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
