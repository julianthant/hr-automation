/**
 * Shared free-tier LLM completion primitive.
 *
 * `completeText` / `completeJson` run ONE text prompt across the whole
 * multi-provider pool (`buildTextPool`), driven by the same admission-control
 * usage tracker as OCR (`../ocr/usage-tracker.ts`): it reserves the best
 * available (provider, key, model) cell with headroom now, calls it, and on a
 * 429 / quota / transient error penalizes that cell and falls through to the
 * next model in the chain, then the next key, then the next provider — until one
 * succeeds or the wait budget is spent. This is the "use any available agent; if
 * one is rate-limited, use the next" contract, generalized off the vision path.
 *
 * Both functions are **graceful**: on total exhaustion (every key rate-limited,
 * quota-out, dead, or absent) they return `null` rather than throwing, so a
 * caller (sanity gate, triage, summarizer, normalizer) degrades to "no LLM
 * result" instead of failing the surrounding operation. Callers that need a hard
 * error can check for `null` themselves.
 *
 * State (RPD/RPM/cooldown/dead) persists per `cacheDir` and is SHARED with the
 * OCR pool at the default `.tracker/runtime`, so text and OCR never exhaust each
 * other's free-tier budget.
 */
import type { ZodType } from "zod/v4";
import { log } from "../../utils/log.js";
import { parseJsonLoose } from "../ocr/env-keys.js";
import { errorToRateLimitInfo } from "../ocr/rate-limit-headers.js";
import { type Candidate, getUsageTracker } from "../ocr/usage-tracker.js";
import { buildTextPool, summarizeTextPool, type TextPoolKey } from "./text-pool.js";

const DEFAULT_CACHE_DIR = ".tracker/runtime";
const DEFAULT_MAX_WAIT_MS = 20_000;
const MAX_SINGLE_WAIT_MS = 15_000;

export interface CompleteOptions {
  /** The full prompt sent to the model. */
  prompt: string;
  /** Request JSON output (Gemini responseMimeType / OpenAI response_format). Default true. */
  json?: boolean;
  /**
   * Rough token estimate for admission control (charged to the cell's TPM/RPM
   * gate; reconciled with the real prompt-token count on success). Defaults to a
   * prompt-length heuristic. Pass a bigger value for long inputs (error logs,
   * rosters) so the gate doesn't under-count.
   */
  estTokens?: number;
  /**
   * Usage-tracker + rotation state dir. Defaults to `.tracker/runtime` — SHARED
   * with OCR so per-key daily budgets are respected across both. Override in
   * tests for isolation.
   */
  cacheDir?: string;
  /** Total wait budget across rate-limit pacing before giving up. Default 20s. */
  maxWaitMs?: number;
  /** Restrict which pool cells may serve (e.g. skip a provider/tier). */
  candidateFilter?: (c: Candidate) => boolean;
  /** Inject a fake pool in tests. Defaults to `buildTextPool()`. */
  pool?: TextPoolKey[];
  /** Prefix for log lines (e.g. `"triage"`, `"sanity"`). */
  logTag?: string;
}

export interface CompleteResult {
  /** Raw model text (JSON string when `json` was requested). */
  text: string;
  /** Which pool cell served the result. */
  provider: string;
  model: string;
  keyIndex: number;
  /** How many provider calls were issued before success. */
  attempts: number;
  /** All `provider-key:model` combos attempted (last = the one that succeeded). */
  attemptedKeys: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function comboId(provider: string, keyIndex: number, model: string): string {
  return `${provider}-${keyIndex}:${model}`;
}

/** Rough prompt-token estimate when the caller doesn't supply one. */
function estimateTokens(prompt: string): number {
  // ~4 chars/token for English + a fixed output-budget headroom.
  return Math.max(256, Math.ceil(prompt.length / 4) + 800);
}

/**
 * Build usage-tracker candidates from the text pool, overriding each model's
 * `imgTokens` gate value with the text estimate (the tracker charges
 * `limit.imgTokens` per reserve; for text that field is the wrong magnitude).
 */
function buildCandidates(pool: TextPoolKey[], estTokens: number): Candidate[] {
  return pool.flatMap((k) =>
    k.models.map((m) => ({
      provider: k.providerId,
      keyValue: k.rotationKey,
      keyIndex: k.keyIndex,
      model: m.id,
      limit: { ...m.limit, imgTokens: estTokens },
      priority: k.priority,
      tier: m.tier,
    })),
  );
}

/**
 * Complete a single prompt against the pool, falling through providers/keys/
 * models on rate-limit. Returns the raw text (and which cell served it), or
 * `null` if the whole pool is exhausted / unconfigured within the wait budget.
 */
export async function completeText(opts: CompleteOptions): Promise<CompleteResult | null> {
  const pool = opts.pool ?? buildTextPool();
  const tag = opts.logTag ? `[llm/${opts.logTag}]` : "[llm]";
  if (pool.length === 0) {
    log.warn(`${tag} no LLM API keys configured — skipping (set GEMINI_API_KEY*, GROQ_API_KEY*, …)`);
    return null;
  }

  const json = opts.json ?? true;
  const estTokens = opts.estTokens ?? estimateTokens(opts.prompt);
  const budget = Math.max(0, opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const tracker = getUsageTracker(opts.cacheDir ?? DEFAULT_CACHE_DIR);
  const candidates = buildCandidates(pool, estTokens).filter(opts.candidateFilter ?? (() => true));
  const poolByKey = new Map(pool.map((k) => [`${k.providerId}-${k.keyIndex}`, k]));

  const tried = new Set<string>();
  let remaining = [...candidates];
  let attempts = 0;
  let waited = 0;
  let lastError: unknown;

  try {
    while (remaining.length > 0) {
      const res = tracker.reserve(remaining);
      if (res.kind === "exhausted") {
        lastError = lastError ?? new Error("all LLM keys exhausted (rate-limited, quota-out, or dead)");
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
      attempts += 1;
      try {
        const outcome = await key.callText(opts.prompt, token.model, { json });
        tracker.commit(token, outcome.promptTokens);
        log.step(`${tag} ${combo} → ${outcome.text.length}c (attempt ${attempts})`);
        return {
          text: outcome.text,
          provider: token.provider,
          model: token.model,
          keyIndex: token.keyIndex,
          attempts,
          attemptedKeys: [...tried],
        };
      } catch (err) {
        lastError = err;
        tracker.penalize(token, errorToRateLimitInfo(token.provider, err));
      }
    }
  } finally {
    tracker.flush();
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  log.warn(`${tag} failed after ${attempts} attempt(s) [pool ${summarizeTextPool(pool)}]: ${msg}`);
  return null;
}

/**
 * Like `completeText`, but parse the reply as JSON and validate it against
 * `schema`. Returns the typed value, or `null` when the pool is exhausted, the
 * reply isn't parseable JSON, or it fails schema validation (each logged).
 */
export async function completeJson<T>(
  opts: CompleteOptions & { schema: ZodType<T> },
): Promise<T | null> {
  const result = await completeText({ ...opts, json: opts.json ?? true });
  if (!result) return null;
  const tag = opts.logTag ? `[llm/${opts.logTag}]` : "[llm]";

  let parsed: unknown;
  try {
    parsed = parseJsonLoose(result.text);
  } catch {
    log.warn(`${tag} ${result.provider}-${result.keyIndex}:${result.model} returned non-JSON: ${result.text.slice(0, 200).replace(/\n/g, " ")}`);
    return null;
  }

  const validated = opts.schema.safeParse(parsed);
  if (!validated.success) {
    const reason = validated.error.issues
      .slice(0, 2)
      .map((i) => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`)
      .join("; ");
    log.warn(`${tag} schema validation failed: ${reason}`);
    return null;
  }
  return validated.data;
}
