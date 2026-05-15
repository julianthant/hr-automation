import { normalizeEid } from "../matching/index.js";
import { log } from "../../utils/log.js";
import { readGeminiKeys, callGeminiJsonText } from "./env-keys.js";

export interface LookupSuggestion {
  name?: string;
  emplId?: string;
  confidence?: number;
  reason?: string;
}

export function buildLookupSuggestionPrompt(input: {
  formType: string;
  recordJson: string;
}): string {
  return `You are helping recover an HR identity lookup from one OCR record that did not fuzzy-match the roster.

Form type: ${input.formType}
OCR record JSON:
${input.recordJson}

Return 2-3 plausible lookup candidates. Use name when the name is recoverable. Use emplId when an employee ID appears recoverable. Prefer high-precision guesses and do not invent unrelated people.

Respond with ONLY JSON:
{"suggestions":[{"name":"Possible Name","confidence":0.0},{"emplId":"10000001","confidence":0.0}]}

If nothing is plausible, return {"suggestions":[]}.`;
}

export function parseLookupSuggestionResponse(text: string): LookupSuggestion[] {
  const parsed = parseJsonish(text);
  const rawSuggestions = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.suggestions)
      ? parsed.suggestions
      : [];

  const suggestions: LookupSuggestion[] = [];
  const seen = new Set<string>();
  for (const raw of rawSuggestions) {
    if (!isRecord(raw)) continue;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const emplId = normalizeEid(raw.emplId);
    if (!name && !emplId) continue;
    const key = emplId ? `eid:${emplId}` : `name:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({
      ...(name ? { name } : {}),
      ...(emplId ? { emplId } : {}),
      ...(typeof raw.confidence === "number" ? { confidence: raw.confidence } : {}),
      ...(typeof raw.reason === "string" && raw.reason.trim() ? { reason: raw.reason.trim() } : {}),
    });
    if (suggestions.length >= 3) break;
  }
  return suggestions;
}

export async function suggestLookupCandidates(input: {
  formType: string;
  record: unknown;
}): Promise<LookupSuggestion[]> {
  const keys = readGeminiKeys();
  if (keys.length === 0) {
    log.warn("suggestLookupCandidates: no GEMINI_API_KEY* configured, skipping LLM suggestions");
    return [];
  }
  const prompt = buildLookupSuggestionPrompt({
    formType: input.formType,
    recordJson: stringifyRecord(input.record),
  });
  const text = await callGeminiJsonText(keys, prompt, "suggestLookupCandidates");
  if (text === null) return [];
  return parseLookupSuggestionResponse(text);
}

function parseJsonish(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        return null;
      }
    }
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringifyRecord(record: unknown): string {
  try {
    return JSON.stringify(record, null, 2);
  } catch {
    return String(record);
  }
}

