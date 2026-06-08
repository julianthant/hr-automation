import path from "node:path";
import type { ZodType } from "zod/v4";
import { log } from "../../utils/log.js";
import { buildVisionPool, summarizePool, type PoolKey } from "./per-page-pool.js";
import { errorToRateLimitInfo } from "./rate-limit-headers.js";
import { type Candidate, getUsageTracker, type UsageTracker } from "./usage-tracker.js";

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
  /** Override the usage-tracker state directory for tests. */
  cacheDir?: string;
}

export interface PerPageOcrResult<T> {
  records: Array<T & { sourcePage: number }>;
  /** Per-page status, ordered by page number (1-indexed at element 0). */
  pages: Array<{
    page: number;
    success: boolean;
    error?: string;
    /** Pool entry (and model) that succeeded, or the last one tried on failure. */
    poolKeyId?: string;
    /** All `provider-key:model` combos attempted for this page. */
    attemptedKeys?: string[];
    /** How many provider calls were issued for this page. */
    attempts?: number;
  }>;
  /** Compact pool summary (e.g. `"gemini=6 groq=7 mistral=2"`) for logging. */
  poolSummary: string;
}

/** @internal — test escape hatch. Bypasses the pool + tracker entirely. */
type CallSinglePageFn = (args: {
  imagePath: string;
  prompt: string;
  pageNum: number;
}) => Promise<{ json: unknown; poolKeyId: string }>;

let _callSinglePageForTests: CallSinglePageFn | undefined;
const DEFAULT_CACHE_DIR = ".tracker/runtime";

export function __setPerPageCallForTests(fn: CallSinglePageFn | undefined): void {
  _callSinglePageForTests = fn;
}

interface PageOutcome {
  page: number;
  success: boolean;
  error?: string;
  poolKeyId?: string;
  attemptedKeys?: string[];
  attempts?: number;
  rawRecords?: unknown[];
}

/** Per-page wait budget: how long a single page may pace itself before failing. */
function maxWaitMs(): number {
  const env = Number.parseInt(process.env.OCR_PAGE_MAX_WAIT_MS ?? "", 10);
  return Number.isFinite(env) && env >= 0 ? env : 120_000;
}
const MAX_SINGLE_WAIT_MS = 15_000;

function comboId(provider: string, keyIndex: number, model: string): string {
  return `${provider}-${keyIndex}:${model}`;
}

function buildCandidates(pool: PoolKey[]): Candidate[] {
  return pool.flatMap((k) =>
    k.models.map((m) => ({
      provider: k.providerId,
      keyValue: k.rotationKey,
      keyIndex: k.keyIndex,
      model: m.id,
      limit: m.limit,
      priority: k.priority,
    })),
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * OCR every page of a pre-rendered PDF in parallel. Each page is dispatched
 * through the usage tracker, which picks the best available (provider, key,
 * model) cell — pacing within each provider's RPM/TPM/RPD and falling back
 * across the model chain then other keys on a 429/quota/transient error. The
 * tracker is shared in-memory per `cacheDir`, so concurrent runs see each
 * other's throttle state.
 *
 * Concurrency = `min(pool.length, OCR_PAGE_CONCURRENCY ?? pool.length)`. Pages
 * that fail completely surface as `success: false` and are omitted from
 * `records`; the caller decides whether to surface the partial result.
 */
export async function runOcrPerPage<T>(req: PerPageOcrRequest<T>): Promise<PerPageOcrResult<T>> {
  const pool = req.pool ?? buildVisionPool();
  const poolSummary = summarizePool(pool);
  if (pool.length === 0 && !_callSinglePageForTests) {
    throw new Error(
      "runOcrPerPage: no vision API keys configured (set GEMINI_API_KEY*, GROQ_API_KEY*, MISTRAL_API_KEY*, OPEN_ROUTER_API_KEY*, or SAMBANOVA_API_KEY*)",
    );
  }

  const concurrencyEnv = Number.parseInt(process.env.OCR_PAGE_CONCURRENCY ?? "", 10);
  const fallbackConcurrency = pool.length > 0 ? pool.length : 4;
  const concurrency = Math.max(
    1,
    Number.isFinite(concurrencyEnv) && concurrencyEnv > 0
      ? Math.min(concurrencyEnv, Math.max(fallbackConcurrency, 1))
      : fallbackConcurrency,
  );

  // The test-fn path bypasses the pool + tracker entirely, so don't even create
  // (and flush an empty state file for) the tracker in that case.
  const usingTestFn = Boolean(_callSinglePageForTests);
  const tracker = usingTestFn ? null : getUsageTracker(req.cacheDir ?? DEFAULT_CACHE_DIR);
  const candidates = usingTestFn ? [] : buildCandidates(pool);
  const poolByKey = new Map(pool.map((k) => [`${k.providerId}-${k.keyIndex}`, k]));

  const tasks = req.pagesAsImages.map((filename, idx) => ({
    pageNum: idx + 1,
    imagePath: path.join(req.pageImagesDir, filename),
  }));
  const results: PageOutcome[] = new Array(tasks.length);

  const limit = makeLimiter(concurrency);
  try {
    await Promise.all(
      tasks.map((t) =>
        limit(async () => {
          results[t.pageNum - 1] = tracker
            ? await ocrPageViaPool(t.pageNum, t.imagePath, req.prompt, candidates, poolByKey, tracker)
            : await ocrPageViaTestFn(t.pageNum, t.imagePath, req.prompt, pool);
        }),
      ),
    );
  } finally {
    tracker?.flush();
  }

  return finalize(results, req.schema, poolSummary);
}

/** Test path: one attempt per page through the injected callback. */
async function ocrPageViaTestFn(
  pageNum: number,
  imagePath: string,
  prompt: string,
  pool: PoolKey[],
): Promise<PageOutcome> {
  // The page's assigned pool key id — reported as the attempted key on failure
  // (the test-fn supplies its own poolKeyId on success).
  const assignedId = pool.length > 0 ? pool[(pageNum - 1) % pool.length].id : undefined;
  try {
    const { json, poolKeyId } = await _callSinglePageForTests!({ imagePath, prompt, pageNum });
    return {
      page: pageNum,
      success: true,
      poolKeyId,
      attemptedKeys: [poolKeyId],
      attempts: 1,
      rawRecords: Array.isArray(json) ? (json as unknown[]) : [json],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`runOcrPerPage page ${pageNum} failed: ${msg}`);
    return {
      page: pageNum,
      success: false,
      error: msg,
      poolKeyId: assignedId,
      attemptedKeys: assignedId ? [assignedId] : [],
      attempts: 1,
    };
  }
}

/** Real path: tracker-driven (key, model) selection with backoff + pacing. */
async function ocrPageViaPool(
  pageNum: number,
  imagePath: string,
  prompt: string,
  candidates: Candidate[],
  poolByKey: Map<string, PoolKey>,
  tracker: UsageTracker,
): Promise<PageOutcome> {
  const tried = new Set<string>();
  let remaining = [...candidates];
  let attempts = 0;
  let waited = 0;
  let lastError: unknown;
  let lastPoolKeyId: string | undefined;
  const budget = maxWaitMs();

  while (remaining.length > 0) {
    const res = tracker.reserve(remaining);
    if (res.kind === "exhausted") {
      lastError = lastError ?? new Error("all vision keys exhausted (rate-limited, quota-out, or dead)");
      break;
    }
    if (res.kind === "wait") {
      const w = Math.min(res.waitMs, MAX_SINGLE_WAIT_MS);
      if (waited + w > budget) {
        lastError = lastError ?? new Error(`rate-limited on every key; waited ${waited}ms (budget ${budget}ms)`);
        break;
      }
      waited += w;
      await sleep(w);
      continue;
    }

    const { token } = res;
    const combo = comboId(token.provider, token.keyIndex, token.model);
    tried.add(combo);
    remaining = remaining.filter((c) => comboId(c.provider, c.keyIndex, c.model) !== combo);
    const key = poolByKey.get(`${token.provider}-${token.keyIndex}`);
    if (!key) continue;
    lastPoolKeyId = key.id;
    attempts += 1;
    try {
      const outcome = await key.callOcr(imagePath, prompt, token.model);
      tracker.commit(token, outcome.promptTokens);
      const arr = Array.isArray(outcome.json) ? (outcome.json as unknown[]) : [outcome.json];
      return {
        page: pageNum,
        success: true,
        poolKeyId: combo,
        attemptedKeys: [...tried],
        attempts,
        rawRecords: arr,
      };
    } catch (err) {
      lastError = err;
      tracker.penalize(token, errorToRateLimitInfo(token.provider, err));
    }
  }

  const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
  log.warn(`runOcrPerPage page ${pageNum} failed after ${attempts} attempt(s): ${errMsg}`);
  return {
    page: pageNum,
    success: false,
    error: errMsg,
    poolKeyId: lastPoolKeyId,
    attemptedKeys: [...tried],
    attempts,
  };
}

/** Shared post-processing: unwrap nested shapes, inject defaults, schema-validate. */
function finalize<T>(
  results: PageOutcome[],
  schema: ZodType<T>,
  poolSummary: string,
): PerPageOcrResult<T> {
  // Some models (notably Gemini 3) wrap records in a per-page object:
  // `[{pageNumber, documentType, records: [...]}]` instead of the flat array
  // we asked for. Unwrap before validation so the schema doesn't strip fields.
  for (const r of results) {
    if (!r.success || !r.rawRecords) continue;
    r.rawRecords = r.rawRecords.flatMap((rec) => {
      if (rec && typeof rec === "object" && Array.isArray((rec as { records?: unknown }).records)) {
        return (rec as { records: unknown[] }).records;
      }
      if (rec && typeof rec === "object" && Array.isArray((rec as { data?: unknown }).data)) {
        return (rec as { data: unknown[] }).data;
      }
      return [rec];
    });
  }

  // Inject rowIndex (array position), employeeSigned (default true), and the
  // runner-authoritative sourcePage before validation. Spread order: defaults
  // first, LLM record next, sourcePage last (always wins).
  const records: Array<T & { sourcePage: number }> = [];

  // Track schema-drop errors per page: { pageNum → error messages[] }.
  // Used below to surface "all records dropped" as a failed page instead of
  // a silently-empty page (which gives the operator NO diagnostic and hides
  // clearly-filled forms from review).
  const schemaDropErrors = new Map<number, string[]>();
  const parsedPageNums = new Set<number>();

  for (const r of results) {
    if (!r.success || !r.rawRecords) continue;
    for (const [idx, rec] of r.rawRecords.entries()) {
      const withInjects =
        rec && typeof rec === "object"
          ? { rowIndex: idx, employeeSigned: true, ...(rec as Record<string, unknown>), sourcePage: r.page }
          : rec;
      const parsed = schema.safeParse(withInjects);
      if (!parsed.success) {
        const rawJson = (() => {
          try {
            return JSON.stringify(rec);
          } catch {
            return String(rec);
          }
        })();
        const reason = parsed.error.issues
          .slice(0, 1)
          .map((i) => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`)
          .join("; ");
        log.warn(
          `runOcrPerPage page ${r.page} record dropped (schema): ${reason} — raw: ${rawJson.slice(0, 300)}`,
        );
        const existing = schemaDropErrors.get(r.page) ?? [];
        existing.push(reason);
        schemaDropErrors.set(r.page, existing);
        continue;
      }
      parsedPageNums.add(r.page);
      records.push({ ...(parsed.data as T), sourcePage: r.page });
    }
  }

  // Build the pages array.  For a page that "succeeded" (API call returned
  // data) but had ALL records dropped by schema validation, surface it as
  // `success: false` with a diagnostic error rather than letting the
  // orchestrator classify it as a silently-empty page (which gives the
  // operator no signal that a clearly-filled form was seen but rejected).
  // A page is only flipped to failed when it contributed NO valid records
  // AND had at least one schema drop — this preserves pages where some
  // records were valid and others were bad (partial extraction is OK).
  const finalPages = results.map((r) => {
    if (!r.success) {
      return { page: r.page, success: false, error: r.error, poolKeyId: r.poolKeyId, attemptedKeys: r.attemptedKeys, attempts: r.attempts };
    }
    const drops = schemaDropErrors.get(r.page);
    const hasValidRecord = parsedPageNums.has(r.page);
    if (drops && drops.length > 0 && !hasValidRecord) {
      // All records on this page were dropped by schema validation.  Surface
      // as a failed page so the orchestrator counts it under `failedPages`
      // (visible in the dashboard's page-status summary) rather than an
      // opaque `emptyPage` with no diagnostic.
      const error = `schema validation dropped all ${drops.length} record(s): ${drops.slice(0, 2).join("; ")}`;
      log.warn(`runOcrPerPage page ${r.page} marked FAILED: ${error}`);
      return { page: r.page, success: false, error, poolKeyId: r.poolKeyId, attemptedKeys: r.attemptedKeys, attempts: r.attempts };
    }
    return { page: r.page, success: true, error: r.error, poolKeyId: r.poolKeyId, attemptedKeys: r.attemptedKeys, attempts: r.attempts };
  });

  return {
    records,
    pages: finalPages,
    poolSummary,
  };
}

function makeLimiter(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const run = (): void => {
      active += 1;
      fn().then(
        (val) => {
          active -= 1;
          queue.shift()?.();
          resolve(val);
        },
        (err) => {
          active -= 1;
          queue.shift()?.();
          reject(err);
        },
      );
    };
    if (active < n) run();
    else queue.push(run);
    return promise;
  };
}
