import { buildOcrTriggerHandler } from "./trigger-handler.js";

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
  const handler = buildOcrTriggerHandler<ForceResearchInput, void, ForceResearchResponse["body"]>({
    validate: (input) =>
      !input.sessionId || !input.runId || !Array.isArray(input.recordIndices)
        ? "Missing fields"
        : null,
    ...(opts.triggerForceResearch ? { override: (input) => opts.triggerForceResearch!(input) } : {}),
    run: async (input) => {
      const { runForceResearch } = await import("../../../workflows/ocr/force-research.js");
      await runForceResearch(input, opts.trackerDir);
    },
    onSuccess: () => ({ ok: true }),
    onError: (error) => ({ ok: false, error }),
  });
  return (input: ForceResearchInput): Promise<ForceResearchResponse> =>
    handler(input) as Promise<ForceResearchResponse>;
}
