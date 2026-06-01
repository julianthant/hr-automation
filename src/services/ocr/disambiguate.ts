import { OcrAllKeysExhaustedError, type ProviderKey } from "./types.js";
import { log } from "../../utils/log.js";
import { readGeminiKeys, callGeminiJsonTextWithKey } from "./env-keys.js";
import { classifyOcrError } from "./error-classification.js";
import { KeyRotation, getOrCreateKeyRotation } from "./rotation.js";

export interface DisambiguateInput {
  query: string;
  /** Top-K roster candidates ordered by descending score. */
  candidates: Array<{ eid: string; name: string; score: number }>;
}

export interface DisambiguateResult {
  eid: string | null;
  confidence: number;
}

type DisambiguateCallFn = (key: ProviderKey, prompt: string) => Promise<string>;

const DEFAULT_CACHE_DIR = ".tracker/runtime";
let _cacheDir: string | undefined;
let _callForTests: DisambiguateCallFn | undefined;

export function __setDisambiguateCacheDirForTests(dir: string | undefined): void {
  _cacheDir = dir;
}

export function __setDisambiguateCallForTests(fn: DisambiguateCallFn | undefined): void {
  _callForTests = fn;
}

/**
 * Build the prompt sent to the LLM for disambiguation. Exported for testing.
 */
export function buildDisambiguationPrompt(input: DisambiguateInput): string {
  const candidateList = input.candidates
    .map(
      (c, i) =>
        `${i + 1}. ${c.name} | EID ${c.eid} | algorithmic score ${c.score.toFixed(2)}`,
    )
    .join("\n");
  return `You are matching a name OCR'd from a paper form to one of the candidates from an HR roster.

OCR'd name: "${input.query}"

Candidates:
${candidateList}

Pick the candidate that is the same person, accounting for:
- Common OCR errors (l vs 1, O vs 0, missing diacritics)
- Nicknames (Liz/Elizabeth, Bob/Robert)
- Spelling variants (Renee/Renée, Smyth/Smith)
- Hyphenated surnames may appear as single tokens

Respond with ONLY a JSON object on a single line:
{"eid": "EID_OF_BEST_MATCH", "confidence": 0.0_to_1.0}

If no candidate is plausibly the same person, respond:
{"eid": null, "confidence": 0.0}

Only return the JSON. No prose.`;
}

/**
 * Parse the model's response. Tolerates surrounding prose, code fences,
 * and extra whitespace. Exported for testing.
 */
export function parseDisambiguationResponse(text: string): DisambiguateResult {
  const match = text.match(/\{[^{}]*"eid"[^{}]*\}/);
  if (!match) return { eid: null, confidence: 0 };
  try {
    const parsed = JSON.parse(match[0]) as {
      eid: string | null;
      confidence: number;
    };
    return {
      eid:
        parsed.eid === null || parsed.eid === undefined
          ? null
          : String(parsed.eid),
      confidence:
        typeof parsed.confidence === "number" ? parsed.confidence : 0,
    };
  } catch {
    return { eid: null, confidence: 0 };
  }
}


/**
 * Send a disambiguation request to Gemini. Returns null EID on any
 * failure (no keys, network, API error, parse error). Caller should
 * fall back to algorithmic match (which already produced a "borderline"
 * winner) or treat the record as unresolved.
 *
 * Uses the same `GEMINI_API_KEY*` pool and persisted rotation state as
 * the OCR module. Transient/rate-limit/quota/auth failures mark only the
 * affected key before trying the next available key.
 */
export async function disambiguateMatch(
  input: DisambiguateInput,
): Promise<DisambiguateResult> {
  const keys = readGeminiKeys();
  if (keys.length === 0) {
    return { eid: null, confidence: 0 };
  }
  const prompt = buildDisambiguationPrompt(input);
  const rotation = getOrCreateKeyRotation(
    "gemini-disambiguate",
    keys,
    _cacheDir ?? DEFAULT_CACHE_DIR,
  );
  const call = _callForTests ?? ((key: ProviderKey, textPrompt: string) =>
    callGeminiJsonTextWithKey(key.value, textPrompt));
  let lastError: unknown;

  for (let attempts = 0; attempts < keys.length; attempts++) {
    let key: ProviderKey;
    try {
      key = rotation.pickNext();
    } catch (err) {
      rotation.flush();
      if (err instanceof OcrAllKeysExhaustedError) return { eid: null, confidence: 0 };
      throw err;
    }

    try {
      const text = await call(key, prompt);
      rotation.markSuccess();
      rotation.flush();
      return parseDisambiguationResponse(text);
    } catch (err) {
      lastError = err;
      markDisambiguationKeyFailure(rotation, key, err);
    }
  }

  rotation.flush();
  log.warn(`disambiguateMatch failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  return { eid: null, confidence: 0 };
}

function markDisambiguationKeyFailure(
  rotation: KeyRotation,
  key: ProviderKey,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  switch (classifyOcrError(err)) {
    case "auth":
      rotation.markDead(key);
      log.warn(`disambiguateMatch: auth error on Gemini key ${key.index} — ${message}`);
      return;
    case "quota-exhausted":
      rotation.markQuotaExhausted(key, nextUtcMidnight());
      return;
    case "rate-limit":
      rotation.markRateLimited(key, Date.now() + 60_000);
      return;
    case "transient":
    case "permanent":
      rotation.markRateLimited(key, Date.now() + 5_000);
  }
}

function nextUtcMidnight(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}
