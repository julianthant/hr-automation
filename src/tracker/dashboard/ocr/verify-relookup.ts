import { errorMessage } from "../../../utils/errors.js";
import type { VerifyRelookupKind } from "../../../workflows/ocr/verify-relookup.js";

// ─── POST /api/ocr/verify-relookup ───────────────────────────

export interface VerifyRelookupInput {
  sessionId: string;
  runId: string;
  recordIndex: number;
  lookup: VerifyRelookupKind;
}
export interface VerifyRelookupResponse {
  status: 200 | 400;
  body: { ok: boolean; error?: string };
}
export interface VerifyRelookupHandlerOpts {
  trackerDir?: string;
  triggerVerifyRelookup?: (input: VerifyRelookupInput) => Promise<void>;
}
export function buildOcrVerifyRelookupHandler(opts: VerifyRelookupHandlerOpts = {}) {
  return async (input: VerifyRelookupInput): Promise<VerifyRelookupResponse> => {
    if (
      !input.sessionId ||
      !input.runId ||
      !Number.isInteger(input.recordIndex) ||
      input.recordIndex < 0 ||
      (input.lookup !== "person" && input.lookup !== "i9")
    ) {
      return { status: 400, body: { ok: false, error: "Missing or invalid fields" } };
    }
    if (opts.triggerVerifyRelookup) {
      try {
        await opts.triggerVerifyRelookup(input);
      } catch (err) {
        return { status: 400, body: { ok: false, error: errorMessage(err) } };
      }
    } else {
      const { runVerifyRelookup } = await import("../../../workflows/ocr/verify-relookup.js");
      try {
        await runVerifyRelookup(input, opts.trackerDir);
      } catch (err) {
        return { status: 400, body: { ok: false, error: errorMessage(err) } };
      }
    }
    return { status: 200, body: { ok: true } };
  };
}
