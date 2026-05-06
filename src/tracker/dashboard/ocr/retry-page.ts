import { log } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import { runOcrRetryPage, RetryPageError } from "../../../workflows/ocr/retry-page.js";
import { rowKey, hasRowLock, acquireRowLock, releaseRowLock } from "./lock.js";

// ─── POST /api/ocr/retry-page ─────────────────────────────────

export interface RetryPageBody {
  sessionId: string;
  runId: string;
  pageNum: number;
}
export interface RetryPageHttpResponse {
  status: 200 | 400 | 404 | 409 | 410;
  body: { ok: true; page: number; recordsAdded: number; stillFailed: boolean } | { ok: false; error: string };
}
export interface RetryPageHandlerOpts {
  trackerDir?: string;
  runRetryPageOverride?: (input: RetryPageBody, opts: { trackerDir?: string }) => Promise<{
    ok: true; page: number; recordsAdded: number; stillFailed: boolean;
  }>;
}

export function buildOcrRetryPageHandler(opts: RetryPageHandlerOpts = {}) {
  const trackerDir = opts.trackerDir;
  return async (input: RetryPageBody): Promise<RetryPageHttpResponse> => {
    if (!input.sessionId || !input.runId || typeof input.pageNum !== "number" || input.pageNum < 1) {
      return { status: 400, body: { ok: false, error: "Missing or invalid sessionId/runId/pageNum" } };
    }
    const key = rowKey(input.sessionId, input.runId);
    if (hasRowLock(key)) {
      return { status: 409, body: { ok: false, error: "Retry already in progress for this row" } };
    }
    acquireRowLock(key);
    try {
      const fn = opts.runRetryPageOverride ?? (async (i, o) => {
        return runOcrRetryPage(i, { trackerDir: o.trackerDir });
      });
      const result = await fn(input, { trackerDir });
      return { status: 200, body: { ok: true, page: result.page, recordsAdded: result.recordsAdded, stillFailed: result.stillFailed } };
    } catch (err) {
      if (err instanceof RetryPageError) {
        const status: 400 | 404 | 409 | 410 =
          err.code === "row-not-found" ? 404 :
          err.code === "row-not-mutable" ? 409 :
          err.code === "image-missing" ? 410 :
          400; // spec-missing
        return { status, body: { ok: false, error: err.message } };
      }
      log.error(`[ocr-http] retry-page threw: ${errorMessage(err)}`);
      return { status: 400, body: { ok: false, error: errorMessage(err) } };
    } finally {
      releaseRowLock(key);
    }
  };
}
