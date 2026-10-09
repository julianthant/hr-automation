/**
 * Run summarization — turn a run's log lines into a plain-English operator
 * digest: what the run did, how it ended, and (if it failed) why + the next
 * step. The operator-facing companion to the raw `.tracker/logs/*.jsonl` stream.
 *
 * Pure and graceful: takes log TEXT (the caller reads/filters the tracker), asks
 * the shared free-tier pool, and returns `null` on exhaustion / bad reply. It
 * neither reads the tracker nor writes anything — the CLI
 * (`src/scripts/ops/summarize-run.ts`) supplies the log text; a future dashboard
 * "explain this run" affordance would too.
 */
import { z } from "zod/v4";
import { completeJson } from "./complete.js";
import type { CompleteOptions } from "./complete.js";

export const RUN_OUTCOMES = ["completed", "failed", "cancelled", "running", "unknown"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

const SummarySchema = z.object({
  summary: z.string().min(1),
  outcome: z.enum(RUN_OUTCOMES),
  highlights: z.array(z.string()),
});
export type RunSummary = z.infer<typeof SummarySchema>;

export interface SummarizeRunInput {
  /** The run's log lines (raw JSONL or already-extracted messages). */
  logText: string;
  /** Workflow name for context (e.g. "separations"). */
  workflow?: string;
}

/**
 * Summarize a run from its log text. Returns `{ summary, outcome, highlights }`
 * or `null` on exhaustion / unusable reply. `opts` forwards pool/cacheDir.
 */
export async function summarizeRun(
  input: SummarizeRunInput,
  opts: Pick<CompleteOptions, "cacheDir" | "pool" | "maxWaitMs"> = {},
): Promise<RunSummary | null> {
  const logText = input.logText.trim();
  if (!logText) return null;

  const prompt = `You are summarizing one run of a browser-automation HR workflow for the operator.${input.workflow ? ` Workflow: ${input.workflow}.` : ""}
Read the log lines and produce a SHORT operator digest: what the run did, how it ended, and — if it failed or was cancelled — the likely reason and the next step. Be concrete; do not invent steps not in the log.

Log lines:
"""
${logText.slice(0, 12000)}
"""

Respond with ONLY JSON:
{"summary":"<2-3 sentence plain-English digest>","outcome":"completed|failed|cancelled|running|unknown","highlights":["<key step or finding>", "..."]}`;

  const result = await completeJson({
    prompt,
    schema: SummarySchema,
    cacheDir: opts.cacheDir,
    pool: opts.pool,
    maxWaitMs: opts.maxWaitMs,
    logTag: "summarize",
    estTokens: 4000,
  });
  return result;
}
