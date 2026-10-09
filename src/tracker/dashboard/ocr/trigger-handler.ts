/**
 * Shared factory for OCR operator-trigger HTTP handlers (BM-6).
 *
 * `force-research`, `verify-relookup`, and `retry-page` are all "validate →
 * (test-seam trigger? : dynamic import) → try/catch → respond" entrypoints.
 * force-research / verify-relookup are near byte-identical; retry-page adds a
 * per-row lock + an error-code→status map. This factory unifies the validate +
 * test-override dual-path + try/catch + optional lock + error mapping so the
 * three handlers differ only in their validator, run target, and error shape.
 */
import { errorMessage } from "../../../utils/errors.js";

/** A simple `{ status, body }` HTTP response over a JSON body. */
export interface OcrTriggerResponse<TBody> {
  status: number;
  body: TBody;
}

export interface OcrTriggerHandlerSpec<TInput, TResult, TBody> {
  /**
   * Validate the input. Return an error message string to reject with 400, or
   * `null` to proceed.
   */
  validate: (input: TInput) => string | null;
  /**
   * The trigger override (test seam). When provided on the request it REPLACES
   * the real run — the factory extracts it from the handler opts. Return
   * `undefined` (no override configured) to run the real target.
   */
  override?: (input: TInput) => Promise<TResult> | undefined;
  /** Run the real target (dynamic import + call). */
  run: (input: TInput) => Promise<TResult>;
  /** Build the 200 success body from the result. */
  onSuccess: (result: TResult) => TBody;
  /** Build the 400 (default) error body. */
  onError: (message: string) => TBody;
  /**
   * Map a thrown error to a specific `{ status, body }` (e.g. retry-page's
   * RetryPageError code → 404/409/410). Return `null` to fall through to the
   * default 400 `onError`. Optional.
   */
  mapError?: (err: unknown) => OcrTriggerResponse<TBody> | null;
  /**
   * Per-row lock. When provided, the handler acquires the lock before running
   * and releases it after; a held lock short-circuits with `onLocked`.
   * Optional.
   */
  lock?: {
    key: (input: TInput) => string;
    isHeld: (key: string) => boolean;
    acquire: (key: string) => void;
    release: (key: string) => void;
    onLocked: () => OcrTriggerResponse<TBody>;
  };
}

/**
 * Build an OCR trigger HTTP handler from a spec. The returned handler runs:
 * validate → (lock) → (override ?? run) → onSuccess, mapping thrown errors via
 * `mapError` (or the default 400 `onError`).
 */
export function buildOcrTriggerHandler<TInput, TResult, TBody>(
  spec: OcrTriggerHandlerSpec<TInput, TResult, TBody>,
): (input: TInput) => Promise<OcrTriggerResponse<TBody>> {
  return async (input: TInput): Promise<OcrTriggerResponse<TBody>> => {
    const validationError = spec.validate(input);
    if (validationError !== null) {
      return { status: 400, body: spec.onError(validationError) };
    }

    const lockKey = spec.lock?.key(input);
    if (spec.lock && lockKey !== undefined) {
      if (spec.lock.isHeld(lockKey)) return spec.lock.onLocked();
      spec.lock.acquire(lockKey);
    }

    try {
      const overridden = spec.override?.(input);
      const result = overridden !== undefined ? await overridden : await spec.run(input);
      return { status: 200, body: spec.onSuccess(result) };
    } catch (err) {
      const mapped = spec.mapError?.(err);
      if (mapped) return mapped;
      return { status: 400, body: spec.onError(errorMessage(err)) };
    } finally {
      if (spec.lock && lockKey !== undefined) spec.lock.release(lockKey);
    }
  };
}
