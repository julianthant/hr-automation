import { GoogleGenerativeAI } from "@google/generative-ai";
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
      const genai = new GoogleGenerativeAI(key);
      const model = genai.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: { responseMimeType: "application/json" },
      });
      const raw = (await model.generateContent([{ text: prompt }])) as {
        response: { text(): string };
      };
      return raw.response.text();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (/401|unauthor|invalid\s*api\s*key/i.test(message)) {
        log.warn(`${logTag}: auth error on Gemini key — ${message}`);
        break;
      }
    }
  }
  log.warn(`${logTag} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  return null;
}
