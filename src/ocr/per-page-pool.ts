/**
 * Multi-provider vision-OCR key pool. Used by `runOcrPerPage` to fan
 * pages out across every available API key on every supported provider
 * in parallel — Gemini primary, plus OpenAI-compatible fallbacks
 * (Mistral / Groq / Sambanova) so a 30-page PDF can finish in roughly
 * `ceil(pages / pool.length)` round-trips instead of `pages / 6`.
 *
 * The pool is built dynamically from `process.env` at call time; only
 * keys that are actually set show up. Each entry is a `PoolKey` with a
 * `callOcr(imagePath, prompt)` method that returns parsed JSON. Errors
 * (network, 4xx, 5xx, JSON parse) bubble up to the per-page driver so
 * it can mark that page failed and (optionally) retry on a different
 * key.
 */
import fs from "node:fs/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";

export interface PoolKey {
  /** Stable id for logging — e.g. `"gemini-1"`, `"mistral-2"`. */
  id: string;
  /** Provider family. Used by callers to bias/distribute work. */
  providerId: "gemini" | "mistral" | "groq" | "sambanova";
  /** 1-based index within the provider's key set. */
  keyIndex: number;
  /** Run OCR on a single PNG using this provider+key. Returns parsed JSON. */
  callOcr(imagePath: string, prompt: string): Promise<unknown>;
}

// ─── Env reading ─────────────────────────────────────────────

function readKeys(prefix: string, max = 8): string[] {
  const out: string[] = [];
  // First slot is unsuffixed (e.g. GEMINI_API_KEY); subsequent are
  // numbered (GEMINI_API_KEY2 .. GEMINI_API_KEYN).
  const first = (process.env[prefix] ?? "").trim();
  if (first) out.push(first);
  for (let i = 2; i <= max; i++) {
    const v = (process.env[`${prefix}${i}`] ?? "").trim();
    if (v) out.push(v);
  }
  return out;
}

// ─── Provider call implementations ───────────────────────────

async function callGemini(
  apiKey: string,
  imagePath: string,
  prompt: string,
): Promise<unknown> {
  const png = await fs.readFile(imagePath);
  const genai = new GoogleGenerativeAI(apiKey);
  const model = genai.getGenerativeModel({
    model: process.env.OCR_GEMINI_MODEL ?? "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json" },
  });
  const raw = (await model.generateContent([
    { text: prompt },
    {
      inlineData: { mimeType: "image/png", data: png.toString("base64") },
    },
  ])) as { response: { text(): string } };
  return parseJsonLoose(raw.response.text());
}

async function callOpenAICompatVision(args: {
  endpoint: string;
  apiKey: string;
  model: string;
  imagePath: string;
  prompt: string;
  /** Most providers honor `response_format: {type: "json_object"}`; Groq has spotty support per-model. */
  jsonMode: boolean;
}): Promise<unknown> {
  const png = await fs.readFile(args.imagePath);
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const body: Record<string, unknown> = {
    model: args.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: args.prompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    // Cap output so a runaway model doesn't burn quota; OCR responses
    // for one form fit comfortably in 4 KB of tokens.
    max_tokens: 4096,
    temperature: 0,
  };
  if (args.jsonMode) {
    body.response_format = { type: "json_object" };
  }
  const resp = await fetch(args.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${args.endpoint} ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  return parseJsonLoose(text);
}

/**
 * Tolerant JSON parser — accepts raw JSON, JSON wrapped in ```json fences,
 * or JSON with leading/trailing prose. OCR models occasionally include a
 * sentence before the JSON ("Here's the data:"), and code fences ship
 * with some Groq/Sambanova outputs.
 */
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  // First try: plain JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  // Strip ```json fences.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  // Find the first `{...}` or `[...]` block.
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {
      /* fall through */
    }
  }
  const arrMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]);
    } catch {
      /* fall through */
    }
  }
  throw new Error(`OCR provider returned non-JSON: ${trimmed.slice(0, 200)}`);
}

// ─── Pool builder ────────────────────────────────────────────

/**
 * Read every supported provider's keys out of `process.env` and return
 * a flat pool. Order: Gemini first (best OCR quality), then Mistral
 * (Pixtral), then Groq (Llama 4 vision — fastest), then Sambanova
 * (Llama 3.2 vision). Empty if no keys are configured.
 *
 * Override any provider's model via env:
 *   OCR_GEMINI_MODEL   (default `gemini-2.5-flash`)
 *   OCR_MISTRAL_MODEL  (default `pixtral-12b-2409`)
 *   OCR_GROQ_MODEL     (default `meta-llama/llama-4-scout-17b-16e-instruct`)
 *   OCR_SAMBANOVA_MODEL (default `Llama-3.2-90B-Vision-Instruct`)
 *
 * Disable any provider by unsetting its keys. Disable the entire pool
 * (force the legacy whole-PDF path) by unsetting all of them.
 */
export function buildVisionPool(): PoolKey[] {
  const pool: PoolKey[] = [];

  // Gemini — direct SDK, JSON mode native, model env-overridable.
  const geminiKeys = readKeys("GEMINI_API_KEY");
  geminiKeys.forEach((key, i) => {
    const idx = i + 1;
    pool.push({
      id: `gemini-${idx}`,
      providerId: "gemini",
      keyIndex: idx,
      callOcr: (imagePath, prompt) => callGemini(key, imagePath, prompt),
    });
  });

  // Mistral — OpenAI-compatible /v1/chat/completions with image_url.
  const mistralKeys = readKeys("MISTRAL_API_KEY");
  const mistralModel = process.env.OCR_MISTRAL_MODEL ?? "pixtral-12b-2409";
  mistralKeys.forEach((key, i) => {
    const idx = i + 1;
    pool.push({
      id: `mistral-${idx}`,
      providerId: "mistral",
      keyIndex: idx,
      callOcr: (imagePath, prompt) =>
        callOpenAICompatVision({
          endpoint: "https://api.mistral.ai/v1/chat/completions",
          apiKey: key,
          model: mistralModel,
          imagePath,
          prompt,
          jsonMode: true,
        }),
    });
  });

  // Groq — OpenAI-compatible. Vision models live on the same endpoint.
  // JSON mode is best-effort; the loose parser handles markdown-fenced
  // output some Llama variants emit.
  const groqKeys = readKeys("GROQ_API_KEY");
  const groqModel =
    process.env.OCR_GROQ_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct";
  groqKeys.forEach((key, i) => {
    const idx = i + 1;
    pool.push({
      id: `groq-${idx}`,
      providerId: "groq",
      keyIndex: idx,
      callOcr: (imagePath, prompt) =>
        callOpenAICompatVision({
          endpoint: "https://api.groq.com/openai/v1/chat/completions",
          apiKey: key,
          model: groqModel,
          imagePath,
          prompt,
          jsonMode: false,
        }),
    });
  });

  // Sambanova — OpenAI-compatible.
  const sambanovaKeys = readKeys("SAMBANOVA_API_KEY");
  const sambanovaModel =
    process.env.OCR_SAMBANOVA_MODEL ?? "Llama-3.2-90B-Vision-Instruct";
  sambanovaKeys.forEach((key, i) => {
    const idx = i + 1;
    pool.push({
      id: `sambanova-${idx}`,
      providerId: "sambanova",
      keyIndex: idx,
      callOcr: (imagePath, prompt) =>
        callOpenAICompatVision({
          endpoint: "https://api.sambanova.ai/v1/chat/completions",
          apiKey: key,
          model: sambanovaModel,
          imagePath,
          prompt,
          jsonMode: true,
        }),
    });
  });

  return pool;
}

/**
 * Describe the pool composition for log lines. Doesn't expose key
 * material — only the per-provider count.
 */
export function summarizePool(pool: PoolKey[]): string {
  const counts = new Map<string, number>();
  for (const k of pool) counts.set(k.providerId, (counts.get(k.providerId) ?? 0) + 1);
  const parts: string[] = [];
  for (const [provider, count] of counts) parts.push(`${provider}=${count}`);
  return parts.length > 0 ? parts.join(" ") : "(empty)";
}
