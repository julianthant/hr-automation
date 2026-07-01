/**
 * LLM failure triage — the long-tail companion to the deterministic
 * `classifyError` (`src/utils/errors.ts`).
 *
 * `classifyError` maps known Playwright/network error shapes to a concise
 * message by regex; the many failures it CAN'T match fall through as a raw first
 * line. `triageFailure` takes one of those raw errors + run context and asks the
 * shared free-tier LLM pool for a structured read: a category, a one-sentence
 * plain-English cause, a suggested recovery, and whether a retry is worth it.
 *
 * Graceful and side-effect-free: returns `null` on pool exhaustion / bad reply
 * (a triage is advisory — it must never fail or delay the run's own terminal
 * handling). It reads nothing and writes nothing; the CALLER decides where the
 * result surfaces (a background failure scanner, an on-demand "explain this
 * failure" action, a log line). It is deliberately NOT wired into the terminal-
 * failure emit hot path (`tracked-workflow.ts`), whose catch block carries
 * delicate single-terminal-write invariants.
 */
import { z } from "zod/v4";
import { completeJson } from "./complete.js";
import type { CompleteOptions } from "./complete.js";

/** Coarse failure buckets the model sorts an error into. */
export const TRIAGE_CATEGORIES = [
  "selector-drift",
  "auth-session",
  "network",
  "data-validation",
  "permission",
  "system-outage",
  "timeout",
  "browser",
  "unknown",
] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

const TriageSchema = z.object({
  category: z.enum(TRIAGE_CATEGORIES),
  cause: z.string().min(1),
  suggestedRecovery: z.string().min(1),
  retriable: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type TriageResult = z.infer<typeof TriageSchema>;

export interface TriageInput {
  /** The raw error message / stack (truncate very long stacks before calling). */
  rawError: string;
  /** Workflow name for context (e.g. "separations"). */
  workflow?: string;
  /** The step the run was on when it failed (e.g. "transaction"). */
  step?: string;
  /** The system being driven (e.g. "ucpath", "kuali"). */
  systemId?: string;
}

const CATEGORY_HINT = [
  "selector-drift: an element/locator wasn't found or the page layout changed",
  "auth-session: login/session expired, redirected to SSO, or unauthorized",
  "network: DNS, connection refused, or the host was unreachable",
  "data-validation: the target system rejected a value (bad date, missing field, business rule)",
  "permission: the operator lacks access to the record/action",
  "system-outage: the target system returned a 5xx / maintenance page",
  "timeout: an action or navigation timed out with no clearer cause",
  "browser: the browser/page/tab crashed or was closed",
  "unknown: none of the above fit",
].join("\n");

/**
 * Triage one failure into `{ category, cause, suggestedRecovery, retriable }`,
 * or `null` if the pool is exhausted / the reply is unusable. Reuses the shared
 * rate-limit-aware pool — a rate-limited provider transparently falls through to
 * the next. `opts` forwards pool/cacheDir/maxWaitMs overrides (tests inject a
 * fake pool).
 */
export async function triageFailure(
  input: TriageInput,
  opts: Pick<CompleteOptions, "cacheDir" | "pool" | "maxWaitMs"> = {},
): Promise<TriageResult | null> {
  const rawError = input.rawError.trim();
  if (!rawError) return null;

  const context = [
    input.workflow ? `Workflow: ${input.workflow}` : null,
    input.step ? `Step: ${input.step}` : null,
    input.systemId ? `System: ${input.systemId}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `You are triaging a failure from a browser-automation HR workflow. Classify the error and suggest a recovery for an operator.

${context ? context + "\n" : ""}Error:
"""
${rawError.slice(0, 4000)}
"""

Categories:
${CATEGORY_HINT}

Respond with ONLY JSON:
{"category":"<one category>","cause":"<one plain-English sentence>","suggestedRecovery":"<one concrete next step>","retriable":true|false,"confidence":0.0-1.0}`;

  const result = await completeJson({
    prompt,
    schema: TriageSchema,
    cacheDir: opts.cacheDir,
    pool: opts.pool,
    maxWaitMs: opts.maxWaitMs,
    logTag: "triage",
    // Error stacks can be long; give the admission gate a generous estimate.
    estTokens: 1600,
  });
  return result;
}

/** One-line rendering of a triage result for a log line / row annotation. */
export function summarizeTriage(t: TriageResult): string {
  const retry = t.retriable ? "retriable" : "not retriable";
  return `[${t.category}, ${retry}] ${t.cause} → ${t.suggestedRecovery}`;
}
