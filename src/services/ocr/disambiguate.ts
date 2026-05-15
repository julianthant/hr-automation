import { readGeminiKeys, callGeminiJsonText } from "./env-keys.js";

export interface DisambiguateInput {
  query: string;
  /** Top-K roster candidates ordered by descending score. */
  candidates: Array<{ eid: string; name: string; score: number }>;
}

export interface DisambiguateResult {
  eid: string | null;
  confidence: number;
}

/**
 * Build the prompt sent to the LLM for disambiguation. Exported for testing.
 */
export function buildDisambiguationPrompt(input: DisambiguateInput): string {
  const candidateList = input.candidates
    .map(
      (c, i) =>
        `${i + 1}. ${c.name} | EID ${c.eid} | algorithmic score ${c.score.toFixed(2)}`,
    )
    .join("\n");
  return `You are matching a name OCR'd from a paper form to one of the candidates from an HR roster.

OCR'd name: "${input.query}"

Candidates:
${candidateList}

Pick the candidate that is the same person, accounting for:
- Common OCR errors (l vs 1, O vs 0, missing diacritics)
- Nicknames (Liz/Elizabeth, Bob/Robert)
- Spelling variants (Renee/Renée, Smyth/Smith)
- Hyphenated surnames may appear as single tokens

Respond with ONLY a JSON object on a single line:
{"eid": "EID_OF_BEST_MATCH", "confidence": 0.0_to_1.0}

If no candidate is plausibly the same person, respond:
{"eid": null, "confidence": 0.0}

Only return the JSON. No prose.`;
}

/**
 * Parse the model's response. Tolerates surrounding prose, code fences,
 * and extra whitespace. Exported for testing.
 */
export function parseDisambiguationResponse(text: string): DisambiguateResult {
  const match = text.match(/\{[^{}]*"eid"[^{}]*\}/);
  if (!match) return { eid: null, confidence: 0 };
  try {
    const parsed = JSON.parse(match[0]) as {
      eid: string | null;
      confidence: number;
    };
    return {
      eid:
        parsed.eid === null || parsed.eid === undefined
          ? null
          : String(parsed.eid),
      confidence:
        typeof parsed.confidence === "number" ? parsed.confidence : 0,
    };
  } catch {
    return { eid: null, confidence: 0 };
  }
}


/**
 * Send a disambiguation request to Gemini. Returns null EID on any
 * failure (no keys, network, API error, parse error). Caller should
 * fall back to algorithmic match (which already produced a "borderline"
 * winner) or treat the record as unresolved.
 *
 * Uses the same `GEMINI_API_KEY*` pool as the OCR module. Walks keys
 * sequentially on transient errors; gives up after the first parse
 * success or when all keys have failed.
 */
export async function disambiguateMatch(
  input: DisambiguateInput,
): Promise<DisambiguateResult> {
  const keys = readGeminiKeys();
  if (keys.length === 0) {
    return { eid: null, confidence: 0 };
  }
  const text = await callGeminiJsonText(keys, buildDisambiguationPrompt(input), "disambiguateMatch");
  if (text === null) return { eid: null, confidence: 0 };
  return parseDisambiguationResponse(text);
}
