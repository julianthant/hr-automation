import { log } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import { runOcrRetryPage, RetryPageError } from "../../../workflows/ocr/retry-page.js";
import { rowKey, hasRowLock, acquireRowLock, releaseRowLock } from "./lock.js";
import { buildOcrTriggerHandler } from "./trigger-handler.js";

// ─── POST /api/ocr/retry-page ─────────────────────────────────

export interface RetryPageBody {
  sessionId: string;
  runId: string;
  pageNum: number;
}
type RetryPageOkBody = { ok: true; page: number; recordsAdded: number; stillFailed: boolean };
export interface RetryPageHttpResponse {
  status: 200 | 400 | 404 | 409 | 410;
  body: RetryPageOkBody | { ok: false; error: string };
}
export interface RetryPageHandlerOpts {
  trackerDir?: string;
  runRetryPageOverride?: (input: RetryPageBody, opts: { trackerDir?: string }) => Promise<RetryPageOkBody>;
}

export function buildOcrRetryPageHandler(opts: RetryPageHandlerOpts = {}) {
  const trackerDir = opts.trackerDir;
  const handler = buildOcrTriggerHandler<RetryPageBody, RetryPageOkBody, RetryPageHttpResponse["body"]>({
    validate: (input) =>
      !input.sessionId || !input.runId || typeof input.pageNum !== "number" || input.pageNum < 1
        ? "Missing or invalid sessionId/runId/pageNum"
        : null,
    ...(opts.runRetryPageOverride
      ? { override: (input) => opts.runRetryPageOverride!(input, { trackerDir }) }
      : {}),
    run: (input) => runOcrRetryPage(input, { trackerDir }),
    onSuccess: (result) => ({
      ok: true,
      page: result.page,
      recordsAdded: result.recordsAdded,
      stillFailed: result.stillFailed,
    }),
    onError: (error) => ({ ok: false, error }),
    // RetryPageError carries a code that maps to a specific HTTP status;
    // anything else falls through to the default 400 (with a log line).
    mapError: (err) => {
      if (err instanceof RetryPageError) {
        const status: 400 | 404 | 409 | 410 =
          err.code === "row-not-found" ? 404 :
          err.code === "row-not-mutable" ? 409 :
          err.code === "image-missing" ? 410 :
          400; // spec-missing
        return { status, body: { ok: false, error: err.message } };
      }
      log.error(`[ocr-http] retry-page threw: ${errorMessage(err)}`);
      return null;
    },
    lock: {
      key: (input) => rowKey(input.sessionId, input.runId),
      isHeld: hasRowLock,
      acquire: acquireRowLock,
      release: releaseRowLock,
      onLocked: () => ({ status: 409, body: { ok: false, error: "Retry already in progress for this row" } }),
    },
  });
  return (input: RetryPageBody): Promise<RetryPageHttpResponse> =>
    handler(input) as Promise<RetryPageHttpResponse>;
}
