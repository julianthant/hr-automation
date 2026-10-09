import { ApiError, GoogleGenAI } from "@google/genai";
import { log } from "../../utils/log.js";

const GEMINI_KEY_BASE = "GEMINI_API_KEY";
const GEMINI_MAX_INDEX = 8;

/** Read GEMINI_API_KEY through GEMINI_API_KEY8 from the environment. */
export function readGeminiKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= GEMINI_MAX_INDEX; i++) {
    const name = i === 1 ? GEMINI_KEY_BASE : `${GEMINI_KEY_BASE}${i}`;
    const v = process.env[name]?.trim();
    if (v) keys.push(v);
  }
  return keys;
}

/**
 * Walk Gemini keys sequentially, calling `generateContent` with the given
 * prompt (JSON response mode). Returns the raw response text from the first
 * key that succeeds, or null when all keys fail. Auth errors bail immediately;
 * rate-limit / transient errors try the next key. `logTag` prefixes warnings.
 */
export async function callGeminiJsonText(
  keys: string[],
  prompt: string,
  logTag: string,
): Promise<string | null> {
  let lastError: unknown;
  for (const key of keys) {
    try {
      return await callGeminiJsonTextWithKey(key, prompt);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      // Prefer the SDK's structured status over the message regex — a message
      // format change would otherwise stop this loop from recognizing an auth
      // failure and keep walking keys that cannot work.
      const isAuthError =
        (err instanceof ApiError && err.status === 401) ||
        /401|unauthor|invalid\s*api\s*key/i.test(message);
      if (isAuthError) {
        log.warn(`${logTag}: auth error on Gemini key — ${message}`);
        break;
      }
    }
  }
  log.warn(`${logTag} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  return null;
}

export async function callGeminiJsonTextWithKey(
  key: string,
  prompt: string,
): Promise<string> {
  const genai = new GoogleGenAI({ apiKey: key });
  const raw = await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ text: prompt }],
    config: { responseMimeType: "application/json" },
  });
  // `response.text` is a getter yielding undefined when the candidate carries
  // no text part. Throw so `callGeminiJsonText` can rotate to the next key
  // instead of handing an empty string to `parseJsonLoose`.
  const text = raw.text;
  if (text === undefined) {
    throw new Error(
      `Gemini returned no text part (finishReason=${raw.candidates?.[0]?.finishReason ?? "unknown"})`,
    );
  }
  return text;
}

/**
 * Tolerant JSON parser — accepts raw JSON, JSON wrapped in ```json fences,
 * or JSON with leading/trailing prose. Throws if no JSON can be extracted.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
  }
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch { /* fall through */ }
  }
  const arrMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch { /* fall through */ }
  }
  throw new Error(`OCR provider returned non-JSON: ${trimmed.slice(0, 200)}`);
}
