/**
 * Free-tier capability + limit config for the vision-OCR pool.
 *
 * Everything here is FREE-TIER and best-effort: the published RPM/TPM/RPD
 * numbers shift and several providers don't document them at all, so these
 * seed the *proactive* usage gate (usage-tracker.ts) and are then corrected at
 * runtime by the real `x-ratelimit-*` / `Retry-After` / RetryInfo headers each
 * response carries. Treat the table as a starting estimate, not ground truth.
 *
 * `imgTokens` is the measured prompt-token cost of one ~A4 page image for that
 * model (from scripts/ocr/probe-vision.ts, 2026-06-02) — used to pre-check TPM
 * before the real `usage.prompt_tokens` comes back.
 *
 * Limits are *per model* because free quotas are enforced per model: one Gemini
 * key exhausted on gemini-2.5-flash can still call gemini-2.5-flash-lite. That
 * per-model headroom is the main free-tier multiplier, so the pool walks a
 * model fallback chain per key before moving to the next key.
 *
 * Every default is overridable by env:
 *   OCR_<PROVIDER>_MODELS   comma-separated model chain (first = primary)
 *   e.g. OCR_GEMINI_MODELS="gemini-2.5-flash,gemini-2.5-flash-lite"
 */

export type VisionProviderId = "gemini" | "groq" | "mistral" | "sambanova" | "openrouter";

export interface ModelLimit {
  /** Requests per minute (per key, free tier). */
  rpm: number;
  /** Tokens per minute (per key, free tier). */
  tpm: number;
  /** Requests per day (per key/model, free tier). 0 = no known daily cap. */
  rpd: number;
  /** Measured prompt-token cost of one page image (probe-vision.ts). */
  imgTokens: number;
}

export interface ModelSpec {
  id: string;
  limit: ModelLimit;
  /**
   * Accuracy tier for handwritten extraction. 1 (default) = trusted on hard
   * handwriting; 2 = throughput overflow — observed mangling names/digits
   * (live 2026-06-11: ministral-8b read "Barahona Martell" as "Merrell",
   * llama-4-scout produced "Marbell"/"Mian", nemotron "Barbhane Martelli",
   * gemini-2.5-flash-lite "Juun"). Tier 2 cells are only picked when no
   * tier-1 cell has headroom, and are excluded from second-opinion re-OCR.
   *
   * **Tier 1 is a CORRECTNESS claim, not a speed one, and it must be EARNED by
   * measurement — never by reputation or recency of the model.** The bar is not
   * "reads well"; it is "does not INVENT". A model that emits a confident,
   * plausible SSN for handwriting it cannot actually read is worse than one that
   * returns nothing: UCPath answers "no results" for the invented digits, and a
   * real employee is reported to the operator as a stranger — indistinguishable
   * from a true absence (see `forms/i9.ts`, the 2026-07-13 batch where 17 of 29
   * Section 1s were misread and every verdict shipped as confident).
   *
   * Before promoting ANY model to tier 1, score it page-by-page against
   * hand-read paper truth on real scans and count FABRICATIONS separately from
   * misses (a decline is safe; an invention is not). The 2026-07-14 pass
   * demoted `gemini-2.5-flash` and `mistral-medium-latest` on exactly that
   * evidence, and `extractedBy` on each record exists so this stays measurable.
   */
  tier?: 1 | 2;
}

export interface ProviderConfig {
  id: VisionProviderId;
  /** Lower = preferred when several keys/models have capacity. */
  priority: number;
  /** OpenAI-compatible chat endpoint (undefined for Gemini's native SDK path). */
  endpoint?: string;
  /** Whether to send response_format:{type:"json_object"}. */
  jsonMode: boolean;
  /** Env var prefix for keys (GEMINI_API_KEY, GEMINI_API_KEY2, …). */
  keyEnvPrefix: string;
  /** Env var holding a comma-separated model chain override. */
  modelsEnvVar: string;
  /** Default model fallback chain (first = primary). */
  models: ModelSpec[];
}

// ── Per-model free-tier limits (best-effort; see file header) ────────────────

const GEMINI_FLASH_RPD = 250; // GA flash & preview models: ~250 RPD free.
const GEMINI_LITE_RPD = 1000; // flash-lite class: higher daily allowance.
const GEMINI_TPM = 250_000;

const GEMINI_MODELS: ModelSpec[] = [
  // DEMOTED to tier 2 on 2026-07-14. Benchmarked against hand-read paper truth
  // on 8 scanned I-9 Section 1s: name 2/8, dob 1/8, ssn 1/8 — and, worse, it
  // FABRICATED a date of birth AND an SSN on a page whose handwriting is
  // genuinely illegible, while reporting `illegible: []`. It ignores the
  // prompt's accuracy rule. A model that invents a plausible SSN is not a weak
  // model, it is a dangerous one: UCPath answers "no results" for the invented
  // digits and the operator is told a real employee does not work here.
  { id: "gemini-2.5-flash", limit: { rpm: 10, tpm: GEMINI_TPM, rpd: GEMINI_FLASH_RPD, imgTokens: 1100 }, tier: 2 },
  // Strongest reader in the 2026-07-14 benchmark: name 8/8, dob 8/8, ssn 7/8.
  { id: "gemini-3-flash-preview", limit: { rpm: 10, tpm: GEMINI_TPM, rpd: GEMINI_FLASH_RPD, imgTokens: 1125 } },
  // Overflow: cheaper tokens + higher daily cap; weaker on hard handwriting.
  { id: "gemini-2.5-flash-lite", limit: { rpm: 15, tpm: GEMINI_TPM, rpd: GEMINI_LITE_RPD, imgTokens: 300 }, tier: 2 },
  { id: "gemini-3.1-flash-lite", limit: { rpm: 15, tpm: GEMINI_TPM, rpd: GEMINI_LITE_RPD, imgTokens: 1125 }, tier: 2 },
  // Safest reader in the 2026-07-14 benchmark: 7/8 on every field and the ONLY
  // model that never fabricated — it correctly returned null + `illegible` on
  // the unreadable page. Declining to answer is the behaviour we want.
  { id: "gemini-3.5-flash", limit: { rpm: 10, tpm: GEMINI_TPM, rpd: GEMINI_FLASH_RPD, imgTokens: 1125 } },
];

// Groq: org-level limits, single vision model. ~30 RPM / 30k TPM / 1000 RPD free.
const GROQ_MODELS: ModelSpec[] = [
  { id: "meta-llama/llama-4-scout-17b-16e-instruct", limit: { rpm: 30, tpm: 30_000, rpd: 1000, imgTokens: 2400 }, tier: 2 },
];

// Mistral: free tier not published (≈1 RPS, 1B tok/month). Conservative caps.
const MISTRAL_MODELS: ModelSpec[] = [
  // DEMOTED to tier 2 on 2026-07-14. Same benchmark: it reproduced the exact
  // real-world misreads that started this ("Miralik" for "Mihalik", "Kim" for
  // "Kimi", 004-96-8589 for 604-96-8589, 602-44-9554 for 602-94-9554), it
  // fabricated a DOB on the illegible page, and it even corrupted the SECTION 2
  // cross-check number itself — poisoning the very oracle we use to catch bad
  // reads. Handwritten boxed digits are its weak spot (0/6, 9/4, 8/9).
  { id: "mistral-medium-latest", limit: { rpm: 30, tpm: 500_000, rpd: 2000, imgTokens: 1618 }, tier: 2 },
  { id: "ministral-8b-latest", limit: { rpm: 30, tpm: 500_000, rpd: 2000, imgTokens: 1618 }, tier: 2 },
  { id: "mistral-small-latest", limit: { rpm: 30, tpm: 500_000, rpd: 2000, imgTokens: 1618 }, tier: 2 },
];

// SambaNova: free RPD is brutally low (~20/day) — last-resort overflow only.
const SAMBANOVA_MODELS: ModelSpec[] = [
  { id: "Llama-4-Maverick-17B-128E-Instruct", limit: { rpm: 20, tpm: 200_000, rpd: 20, imgTokens: 2400 } },
  { id: "gemma-4-31B-it", limit: { rpm: 20, tpm: 200_000, rpd: 20, imgTokens: 355 } },
  { id: "gemma-3-12b-it", limit: { rpm: 20, tpm: 200_000, rpd: 20, imgTokens: 1100 }, tier: 2 },
];

// OpenRouter: per-account global ~20 RPM / 50 RPD free (1000 RPD after $10 credit).
// Free vision models (`:free`) confirmed working via probe-vision.ts.
const OPENROUTER_MODELS: ModelSpec[] = [
  { id: "google/gemma-4-31b-it:free", limit: { rpm: 20, tpm: 200_000, rpd: 50, imgTokens: 284 } },
  { id: "google/gemma-4-26b-a4b-it:free", limit: { rpm: 20, tpm: 200_000, rpd: 50, imgTokens: 284 }, tier: 2 },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", limit: { rpm: 20, tpm: 200_000, rpd: 50, imgTokens: 1214 }, tier: 2 },
];

const PROVIDERS: ProviderConfig[] = [
  {
    id: "gemini",
    priority: 1,
    jsonMode: true,
    keyEnvPrefix: "GEMINI_API_KEY",
    modelsEnvVar: "OCR_GEMINI_MODELS",
    models: GEMINI_MODELS,
  },
  {
    id: "groq",
    priority: 2,
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    jsonMode: false,
    keyEnvPrefix: "GROQ_API_KEY",
    modelsEnvVar: "OCR_GROQ_MODELS",
    models: GROQ_MODELS,
  },
  {
    id: "mistral",
    priority: 3,
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    jsonMode: true,
    keyEnvPrefix: "MISTRAL_API_KEY",
    modelsEnvVar: "OCR_MISTRAL_MODELS",
    models: MISTRAL_MODELS,
  },
  {
    id: "openrouter",
    priority: 4,
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    jsonMode: false,
    keyEnvPrefix: "OPEN_ROUTER_API_KEY",
    modelsEnvVar: "OCR_OPENROUTER_MODELS",
    models: OPENROUTER_MODELS,
  },
  {
    id: "sambanova",
    priority: 5,
    endpoint: "https://api.sambanova.ai/v1/chat/completions",
    jsonMode: true,
    keyEnvPrefix: "SAMBANOVA_API_KEY",
    modelsEnvVar: "OCR_SAMBANOVA_MODELS",
    models: SAMBANOVA_MODELS,
  },
];

/** Default per-page image-token estimate when a model isn't in the table. */
export const DEFAULT_IMG_TOKENS = 1500;

/**
 * Resolve a provider's model chain, honoring the legacy single-model env vars
 * (OCR_GEMINI_MODEL, …) and the new comma-list (OCR_GEMINI_MODELS). The
 * single-model var, if set, is prepended as the primary (back-compat).
 */
export function resolveModelChain(cfg: ProviderConfig): ModelSpec[] {
  const listVar = (process.env[cfg.modelsEnvVar] ?? "").trim();
  const legacySingle = (process.env[`OCR_${cfg.id.toUpperCase()}_MODEL`] ?? "").trim();

  if (!listVar && !legacySingle) return cfg.models;

  const byId = new Map(cfg.models.map((m) => [m.id, m]));
  const fallbackLimit = cfg.models[0]?.limit ?? { rpm: 10, tpm: 200_000, rpd: 250, imgTokens: DEFAULT_IMG_TOKENS };
  const ids = (listVar ? listVar.split(",") : [legacySingle])
    .map((s) => s.trim())
    .filter(Boolean);
  if (legacySingle && listVar && !ids.includes(legacySingle)) ids.unshift(legacySingle);

  return ids.map((id) => byId.get(id) ?? { id, limit: fallbackLimit });
}

export function visionProviderConfigs(): ProviderConfig[] {
  return PROVIDERS;
}

export function providerConfig(id: VisionProviderId): ProviderConfig | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
