import { errorMessage } from "../../../utils/errors.js";

// ─── POST /api/ocr/force-research ────────────────────────────

export interface ForceResearchInput {
  sessionId: string;
  runId: string;
  recordIndices: number[];
}
export interface ForceResearchResponse {
  status: 200 | 400;
  body: { ok: boolean; error?: string };
}
export interface ForceResearchHandlerOpts {
  trackerDir?: string;
  triggerForceResearch?: (input: ForceResearchInput) => Promise<void>;
}
export function buildOcrForceResearchHandler(opts: ForceResearchHandlerOpts = {}) {
  return async (input: ForceResearchInput): Promise<ForceResearchResponse> => {
    if (!input.sessionId || !input.runId || !Array.isArray(input.recordIndices)) {
      return { status: 400, body: { ok: false, error: "Missing fields" } };
    }
    if (opts.triggerForceResearch) {
      try {
        await opts.triggerForceResearch(input);
      } catch (err) {
        return { status: 400, body: { ok: false, error: errorMessage(err) } };
      }
    } else {
      const { runForceResearch } = await import("../../../workflows/ocr/force-research.js");
      try {
        await runForceResearch(input, opts.trackerDir);
      } catch (err) {
        return { status: 400, body: { ok: false, error: errorMessage(err) } };
      }
    }
    return { status: 200, body: { ok: true } };
  };
}
