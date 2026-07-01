/**
 * Selector-repair assist for the selector-map loop.
 *
 * When a UCPath / Kuali / etc. selector breaks (the DOM shifted), the manual fix
 * is: `playwright-cli snapshot` → read the accessibility tree → hand-write a new
 * locator → verify. `suggestSelectors` shortcuts the middle: give it the
 * snapshot text + what you're trying to target (+ the broken selector, if any)
 * and it returns candidate Playwright locators, most-likely first, over the
 * shared free-tier pool.
 *
 * Strictly a SUGGESTION engine — it never edits `selectors.ts` and never drives
 * a browser. The operator still verifies each candidate live and adds the
 * `// verified <date>` + catalog regen per the selector-map skill. Returns
 * `null` on pool exhaustion / bad reply.
 */
import { z } from "zod/v4";
import { completeJson } from "./complete.js";
import type { CompleteOptions } from "./complete.js";

export interface SelectorCandidate {
  /** A Playwright locator string (getByRole/getByLabel/getByText or CSS). */
  selector: string;
  /** Why this candidate should match the intended element. */
  rationale: string;
  confidence: number;
}

const SuggestSchema = z.object({
  candidates: z.array(
    z.object({
      selector: z.string().min(1),
      rationale: z.string().min(1),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export interface SuggestSelectorsInput {
  /** Accessibility snapshot text (e.g. `playwright-cli --raw snapshot`). */
  snapshot: string;
  /** What element to target, in plain English (e.g. "the Save button"). */
  intent: string;
  /** The current/broken selector, if repairing one. */
  current?: string;
}

/**
 * Propose candidate Playwright locators for `intent` against `snapshot`.
 * Returns candidates ranked most-likely first, or `null` if the pool is
 * exhausted / the reply is unusable. `opts` forwards pool/cacheDir overrides.
 */
export async function suggestSelectors(
  input: SuggestSelectorsInput,
  opts: Pick<CompleteOptions, "cacheDir" | "pool" | "maxWaitMs"> = {},
): Promise<SelectorCandidate[] | null> {
  const snapshot = input.snapshot.trim();
  const intent = input.intent.trim();
  if (!snapshot || !intent) return null;

  const prompt = `You are repairing a Playwright selector for a browser-automation workflow.

Target element (plain English): ${intent}
${input.current ? `Current selector that no longer matches: ${input.current}\n` : ""}
Accessibility snapshot of the page (roles, names, refs):
"""
${snapshot.slice(0, 8000)}
"""

Propose up to 5 candidate Playwright locators for the target, MOST LIKELY FIRST.
Prefer robust role/name/label/text locators (getByRole, getByLabel, getByText,
getByPlaceholder) over brittle nth-child CSS. Only use elements that appear in
the snapshot — do not invent refs or names.

Respond with ONLY JSON:
{"candidates":[{"selector":"getByRole('button',{name:'Save'})","rationale":"...","confidence":0.0-1.0}]}
Empty array if nothing in the snapshot plausibly matches.`;

  const result = await completeJson({
    prompt,
    schema: SuggestSchema,
    cacheDir: opts.cacheDir,
    pool: opts.pool,
    maxWaitMs: opts.maxWaitMs,
    logTag: "selector",
    estTokens: 3000,
  });
  return result ? result.candidates : null;
}
