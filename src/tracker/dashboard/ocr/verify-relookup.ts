import type { VerifyRelookupKind } from "../../../workflows/ocr/verify-relookup.js";
import { buildOcrTriggerHandler } from "./trigger-handler.js";

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
  const handler = buildOcrTriggerHandler<VerifyRelookupInput, void, VerifyRelookupResponse["body"]>({
    validate: (input) =>
      !input.sessionId ||
      !input.runId ||
      !Number.isInteger(input.recordIndex) ||
      input.recordIndex < 0 ||
      (input.lookup !== "person" && input.lookup !== "i9")
        ? "Missing or invalid fields"
        : null,
    ...(opts.triggerVerifyRelookup ? { override: (input) => opts.triggerVerifyRelookup!(input) } : {}),
    run: async (input) => {
      const { runVerifyRelookup } = await import("../../../workflows/ocr/verify-relookup.js");
      await runVerifyRelookup(input, opts.trackerDir);
    },
    onSuccess: () => ({ ok: true }),
    onError: (error) => ({ ok: false, error }),
  });
  return (input: VerifyRelookupInput): Promise<VerifyRelookupResponse> =>
    handler(input) as Promise<VerifyRelookupResponse>;
}
