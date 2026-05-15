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
