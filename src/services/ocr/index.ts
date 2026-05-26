import { KeyRotation } from "./rotation.js";
import { GeminiProvider } from "./providers/gemini.js";
import { readGeminiKeys } from "./env-keys.js";
import { classifyOcrError } from "./error-classification.js";
import {
  OcrAllKeysExhaustedError,
  OcrProviderError,
  OcrValidationError,
  type OcrProvider,
  type OcrRequest,
  type OcrResult,
} from "./types.js";

export type { OcrRequest, OcrResult, OcrProvider };
export { OcrAllKeysExhaustedError, OcrValidationError, OcrProviderError };

// Gemini OCR results are intentionally never cached — every call to
// ocrDocument re-runs the model. Operators have repeatedly needed to
// re-extract from the same PDF after the model improved or a prompt
// changed; a cache hit silently bypassed both. Page images rendered
// by `renderPdfPagesToPngs` are still kept on disk under
// `.tracker/page-images/<sessionId>/` so the Preview tab loads
// instantly on row reopen — only the LLM output is uncached.
//
// `_cacheDir` is retained because `KeyRotation` persists per-key
// throttle/quota state into it across runs.
const DEFAULT_CACHE_DIR = ".tracker";

let _cacheDir: string | undefined;
let _provider: OcrProvider | undefined;

/** @internal — test escape hatch (used by KeyRotation state file location). */
export function __setCacheDirForTests(dir: string | undefined): void {
  _cacheDir = dir;
}
/** @internal — test escape hatch. */
export function __setProviderForTests(provider: OcrProvider | undefined): void {
  _provider = provider;
}

function getCacheDir(): string {
  return _cacheDir ?? DEFAULT_CACHE_DIR;
}

function getProvider(): OcrProvider {
  return _provider ?? new GeminiProvider();
}

const MAX_VALIDATION_RETRIES = 1; // 1 retry = 2 total attempts

/**
 * Run OCR on a PDF and validate the result against a Zod schema.
 *
 * Every call hits Gemini fresh — there is no result cache (see the
 * file-level note above). Enters a key-rotation loop: each provider
 * error is classified into rate-limit / quota-exhausted / auth /
 * transient and the affected key is marked accordingly. Schema
 * validation failure retries once with the error fed back as a prompt
 * hint, then throws OcrValidationError.
 *
 * Throws:
 *   - OcrAllKeysExhaustedError when every key is unusable.
 *   - OcrValidationError after MAX_VALIDATION_RETRIES + 1 attempts.
 */
export async function ocrDocument<T>(req: OcrRequest<T>): Promise<OcrResult<T>> {
  const cacheDir = getCacheDir(); // KeyRotation persists per-key state here.

  const provider = getProvider();
  const keys = provider.id === "gemini" ? readGeminiKeys() : [];
  if (keys.length === 0) {
    throw new Error(`ocrDocument: no API keys configured for provider "${provider.id}"`);
  }
  const rotation = new KeyRotation(provider.id, keys, cacheDir);

  let lastError: unknown;
  let totalAttempts = 0;
  let validationRetries = 0;
  let validationHint: string | undefined;

  // Hard cap on the loop: keys.length distinct keys + MAX_VALIDATION_RETRIES per key.
  const maxLoops = keys.length * (MAX_VALIDATION_RETRIES + 1);

  while (totalAttempts < maxLoops) {
    let key;
    try {
      key = rotation.pickNext();
    } catch (err) {
      rotation.flush();
      if (err instanceof OcrAllKeysExhaustedError) throw err;
      throw err;
    }
    totalAttempts += 1;

    try {
      const reqWithHint = validationHint
        ? {
            ...req,
            prompt:
              (req.prompt ?? "") +
              `\n\nNOTE: Previous attempt failed schema validation: ${validationHint}`,
          }
        : req;
      const raw = await provider.call(reqWithHint, key);
      const validated = req.schema.safeParse(raw.data);
      if (!validated.success) {
        if (validationRetries < MAX_VALIDATION_RETRIES) {
          validationRetries += 1;
          validationHint = JSON.stringify(validated.error.issues.slice(0, 3));
          continue;
        }
        rotation.flush();
        throw new OcrValidationError(
          `Schema validation failed after ${validationRetries + 1} attempts`,
          {
            issues: validated.error.issues.map((i) => ({
              path: i.path as (string | number)[],
              message: i.message,
            })),
          },
        );
      }
      const result: OcrResult<T> = {
        ...raw,
        data: validated.data,
        attempts: totalAttempts,
        cached: false,
      };
      rotation.markSuccess();
      rotation.flush();
      return result;
    } catch (err) {
      lastError = err;
      switch (classifyOcrError(err)) {
        case "rate-limit":
          rotation.markRateLimited(key, Date.now() + 60_000);
          continue;
        case "quota-exhausted":
          rotation.markQuotaExhausted(key, nextUtcMidnight());
          continue;
        case "auth":
          rotation.markDead(key);
          continue;
        case "transient":
          rotation.markRateLimited(key, Date.now() + 5_000);
          continue;
        case "permanent":
          if (err instanceof OcrProviderError) {
            rotation.markRateLimited(key, Date.now() + 30_000);
            continue;
          }
      }
      // Non-provider error (validation, type) — flush + bubble up.
      rotation.flush();
      throw err;
    }
  }

  rotation.flush();
  if (lastError) throw lastError;
  throw new OcrAllKeysExhaustedError(provider.id, keys.length);
}

function nextUtcMidnight(): number {
  const now = new Date();
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return tomorrow.getTime();
}

export { flattenForData } from "./tracker-data.js";
export { countVerified } from "./records-stats.js";
export {
  computeOcrVerification,
  patchOcrRecordFromActiveCheckOutcome,
  patchOcrRecordFromEidLookupOutcome,
  patchOcrRecordUnresolved,
  type OcrLookupKind,
} from "./eid-lookup-results.js";
export {
  subscribeToApproval,
  emitApproved,
  emitDiscarded,
  OcrDiscardedError,
  OcrApprovalCancelledError,
  type ApprovalKey,
  type ApprovedPayload,
  type SubscribeOpts,
} from "./approval-signal.js";
