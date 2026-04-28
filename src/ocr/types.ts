import type { ZodType } from "zod/v4";

/**
 * Request to ocrDocument<T>() — extracts structured T from a PDF.
 *
 * `schema` validates the LLM output. `schemaName` is a human label used
 * for the cache key + prompt label. `examples` (optional) provide
 * few-shot context. `pageRange` lets callers OCR a subset of pages.
 * `prompt` overrides the default schema-derived prompt entirely.
 * `bustCache: true` skips the cache lookup for one call.
 */
export interface OcrRequest<T> {
  pdfPath: string;
  schema: ZodType<T>;
  schemaName: string;
  examples?: Array<{ pdfPath?: string; output: T }>;
  pageRange?: { start: number; end: number };
  prompt?: string;
  bustCache?: boolean;
}

/**
 * Successful OCR result. `data` is the validated T. Diagnostic fields
 * (provider, keyIndex, attempts, cached, durationMs) help operators
 * inspect what happened — surface them in dashboard rows when useful.
 */
export interface OcrResult<T> {
  data: T;
  rawText?: string;
  pageCount: number;
  provider: string;
  keyIndex: number;
  attempts: number;
  cached: boolean;
  durationMs: number;
}

export interface ProviderKey {
  /** 1-based index for human-readable logging. */
  index: number;
  /** The actual API key value. Treat as secret. */
  value: string;
}

/**
 * Provider interface. Implementations should NOT do schema validation;
 * the orchestrator validates after the call returns. Providers SHOULD
 * throw `OcrProviderError` with a `kind` discriminator on rate-limit /
 * quota / auth / transient errors so the rotation layer can react.
 */
export interface OcrProvider {
  id: string;
  call<T>(req: OcrRequest<T>, key: ProviderKey): Promise<OcrResult<T>>;
}

export class OcrAllKeysExhaustedError extends Error {
  override name = "OcrAllKeysExhaustedError";
  constructor(public providerId: string, public keyCount: number) {
    super(`All ${keyCount} ${providerId} keys exhausted (rate-limited, quota-out, or dead).`);
  }
}

export interface ZodIssueLike {
  path: (string | number)[];
  message: string;
}

export class OcrValidationError extends Error {
  override name = "OcrValidationError";
  constructor(message: string, public zodResult: { issues: ZodIssueLike[] }) {
    super(message);
  }
}

export type ProviderErrorKind = "rate-limit" | "quota-exhausted" | "auth" | "transient" | "unknown";

export class OcrProviderError extends Error {
  override name = "OcrProviderError";
  constructor(message: string, public kind: ProviderErrorKind, public httpStatus?: number) {
    super(message);
  }
}
