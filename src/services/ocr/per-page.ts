import path from "node:path";
import type { ZodType } from "zod/v4";
import { log } from "../../utils/log.js";
import { buildVisionPool, summarizePool, type PoolKey } from "./per-page-pool.js";
import { errorToRateLimitInfo, type RateLimitKind } from "./rate-limit-headers.js";
import { type Candidate, getUsageTracker, type UsageTracker } from "./usage-tracker.js";

export interface PerPageOcrRequest<T> {
  /** PNG filenames inside `pageImagesDir`, 1-indexed by page (e.g. page-01.png). */
  pagesAsImages: string[];
  /**
   * Real document page number per entry of `pagesAsImages`. Defaults to
   * `index + 1`, which is only correct when the WHOLE document is passed.
   *
   * A caller re-reading a SUBSET (the second-opinion re-read passes exactly one
   * page) must supply the true page numbers — otherwise every outcome and log
   * line reports "page 1" regardless of which page actually ran.
   */
  pageNumbers?: number[];
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
  /**
   * Restrict which (provider, key, model) cells may serve these pages —
   * the second-opinion path passes tier-1-only minus the model that
   * produced the suspect reading. All filtered out → pages fail loud.
   */
  candidateFilter?: (c: Candidate) => boolean;
  /** Operator/run cancellation, composed with every provider-attempt timeout. */
  signal?: AbortSignal;
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
/**
 * Tier-1 patience: how long a page may wait for a trusted (tier-1) cell to
 * free up before overflowing to a tier-2 (handwriting-mangling) model. Without
 * this, a batch saturates the tier-1 RPM windows after ~15-20 pages and every
 * later page instantly lands on tier-2 — quality degrades as the batch
 * progresses. Always capped by the remaining page budget, so patience can
 * delay a page but never fail it. 0 disables (old drift behavior).
 */
function tier1PatienceMs(): number {
  const env = Number.parseInt(process.env.OCR_TIER1_PATIENCE_MS ?? "", 10);
  return Number.isFinite(env) && env >= 0 ? env : 90_000;
}
const MAX_SINGLE_WAIT_MS = 15_000;

function providerAttemptTimeoutMs(): number {
  const env = Number.parseInt(process.env.OCR_PROVIDER_ATTEMPT_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : 60_000;
}

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
      tier: m.tier,
    })),
  );
}

const sleepAbortError = (signal?: AbortSignal): Error => {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException("OCR pacing aborted", "AbortError");
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(sleepAbortError(signal));
    return;
  }
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(sleepAbortError(signal));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) signal.throwIfAborted();
}

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
  throwIfAborted(req.signal);
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
  const candidates = (usingTestFn ? [] : buildCandidates(pool)).filter(
    req.candidateFilter ?? (() => true),
  );
  const poolByKey = new Map(pool.map((k) => [`${k.providerId}-${k.keyIndex}`, k]));

  // `slot` (the position in this request) and `pageNum` (the page's identity in
  // the document) are DIFFERENT axes — conflating them made a subset re-read
  // both mis-report its page and index the results array by page number.
  const tasks = req.pagesAsImages.map((filename, idx) => ({
    slot: idx,
    pageNum: req.pageNumbers?.[idx] ?? idx + 1,
    imagePath: path.join(req.pageImagesDir, filename),
  }));
  const results: PageOutcome[] = new Array<PageOutcome>(tasks.length);

  const limit = makeLimiter(concurrency);
  try {
    await Promise.all(
      tasks.map((t) =>
        limit(async () => {
          results[t.slot] = tracker
            ? await ocrPageViaPool(t.pageNum, t.imagePath, req.prompt, candidates, poolByKey, tracker, req.signal)
            : await ocrPageViaTestFn(t.pageNum, t.imagePath, req.prompt, pool, req.signal);
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
  signal?: AbortSignal,
): Promise<PageOutcome> {
  // The page's assigned pool key id — reported as the attempted key on failure
  // (the test-fn supplies its own poolKeyId on success).
  const assignedId = pool.length > 0 ? pool[(pageNum - 1) % pool.length].id : undefined;
  try {
    throwIfAborted(signal);
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
    throwIfAborted(signal);
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

/**
 * Operator-readable reason a cell fell through, for the NEXT attempt's log
 * line. Keyed on the whole `RateLimitKind` union so a new kind fails the build
 * here rather than silently logging `undefined`.
 */
const RETRY_REASON_LABEL: Record<RateLimitKind, string> = {
  "rate-limit": "rate-limited",
  "quota-exhausted": "quota exhausted",
  auth: "auth failed",
  transient: "transient error",
  permanent: "permanent error",
};

/** Real path: tracker-driven (key, model) selection with backoff + pacing. */
async function ocrPageViaPool(
  pageNum: number,
  imagePath: string,
  prompt: string,
  candidates: Candidate[],
  poolByKey: Map<string, PoolKey>,
  tracker: UsageTracker,
  signal?: AbortSignal,
): Promise<PageOutcome> {
  const tried = new Set<string>();
  let remaining = [...candidates];
  let attempts = 0;
  let waited = 0;
  let lastError: unknown;
  let lastPoolKeyId: string | undefined;
  // Why the PREVIOUS attempt fell through (e.g. `gemini-1 rate-limited`), so
  // the next attempt's log line explains itself instead of looking like a
  // duplicate of the same page on a different model.
  let retryReason: string | undefined;
  const budget = maxWaitMs();
  const patience = tier1PatienceMs();

  while (remaining.length > 0) {
    throwIfAborted(signal);
    // Patience shrinks as the page waits and never exceeds the remaining
    // budget — a page degrades to tier-2 rather than failing on patience.
    const res = tracker.reserve(remaining, Date.now(), {
      preferTier1WaitMs: Math.max(0, Math.min(patience, budget) - waited),
    });
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
      await sleep(w, signal);
      continue;
    }

    const { token } = res;
    const combo = comboId(token.provider, token.keyIndex, token.model);
    tried.add(combo);
    // Grab the candidate BEFORE it is filtered out — the reserved token carries
    // no tier, and tier is what tells the operator whether to trust the read.
    const cand = remaining.find((c) => comboId(c.provider, c.keyIndex, c.model) === combo);
    remaining = remaining.filter((c) => comboId(c.provider, c.keyIndex, c.model) !== combo);
    const key = poolByKey.get(`${token.provider}-${token.keyIndex}`);
    if (!key) continue;
    lastPoolKeyId = key.id;
    attempts += 1;
    const attemptSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(providerAttemptTimeoutMs())])
      : AbortSignal.timeout(providerAttemptTimeoutMs());
    try {
      const outcome = await key.callOcr(imagePath, prompt, token.model, attemptSignal, {
        page: pageNum,
        keyId: key.id,
        tier: cand?.tier ?? 1,
        attempt: attempts,
        retryReason,
      });
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
      throwIfAborted(signal);
      lastError = err;
      const info = attemptSignal.aborted
        ? ({ kind: "transient", retryAfterMs: 0 } as const)
        : errorToRateLimitInfo(token.provider, err);
      retryReason = `${key.id} ${attemptSignal.aborted ? "timed out" : RETRY_REASON_LABEL[info.kind]}`;
      tracker.penalize(token, info);
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
      // rowIndex is the record's real position on the page — a safe default when
      // the model omits it. employeeSigned is DELIBERATELY not defaulted: the
      // schema is `.nullable().optional()`, so an omitted value no longer drops
      // the record — and defaulting it to `true` (signed) would let a blank
      // signature line be recorded as signed and fan out as a real oath
      // transaction. Omitted → undefined → downstream treats it as NOT signed
      // (surfaced for review), which is the fail-safe direction.
      const withInjects =
        rec && typeof rec === "object"
          ? { rowIndex: idx, ...(rec as Record<string, unknown>), sourcePage: r.page }
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
      records.push({ ...(parsed.data), sourcePage: r.page });
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
