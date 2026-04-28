import { readFileSync } from "node:fs";
import { computeCacheKey, readCache, writeCache } from "./cache.js";
import { computeSchemaJsonHash, PROMPT_VERSION } from "./prompts.js";
import { KeyRotation } from "./rotation.js";
import { GeminiProvider } from "./providers/gemini.js";
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

const DEFAULT_CACHE_DIR = ".ocr-cache";

let _cacheDir: string | undefined;
let _provider: OcrProvider | undefined;

/** @internal — test escape hatch. */
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

const MAX_VALIDATION_RETRIES = 1; // 1 retry = 2 total attempts

/**
 * Run OCR on a PDF, validate the result against a Zod schema, and
 * cache the typed output.
 *
 * Cache hit returns immediately. Cache miss enters a key-rotation
 * loop: each provider error is classified into rate-limit /
 * quota-exhausted / auth / transient and the affected key is marked
 * accordingly. Schema validation failure retries once with the error
 * fed back as a prompt hint, then throws OcrValidationError.
 *
 * Throws:
 *   - OcrAllKeysExhaustedError when every key is unusable.
 *   - OcrValidationError after MAX_VALIDATION_RETRIES + 1 attempts.
 */
export async function ocrDocument<T>(req: OcrRequest<T>): Promise<OcrResult<T>> {
  const pdfBytes = readFileSync(req.pdfPath);
  const cacheKey = computeCacheKey({
    pdfBytes,
    schemaName: req.schemaName,
    schemaJsonHash: computeSchemaJsonHash(req.schema),
    promptVersion: PROMPT_VERSION,
  });
  const cacheDir = getCacheDir();

  if (!req.bustCache) {
    const cached = readCache<T>(cacheDir, cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  const provider = getProvider();
  const keys = provider.id === "gemini" ? getGeminiKeys() : [];
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
      writeCache(cacheDir, cacheKey, result);
      rotation.markSuccess(key);
      rotation.flush();
      return result;
    } catch (err) {
      lastError = err;
      if (err instanceof OcrProviderError) {
        switch (err.kind) {
          case "rate-limit":
            rotation.markRateLimited(key, Date.now() + 60_000);
            break;
          case "quota-exhausted":
            rotation.markQuotaExhausted(key, nextUtcMidnight());
            break;
          case "auth":
            rotation.markDead(key);
            break;
          case "transient":
            rotation.markRateLimited(key, Date.now() + 5_000);
            break;
          case "unknown":
            rotation.markRateLimited(key, Date.now() + 30_000);
            break;
        }
        continue;
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
