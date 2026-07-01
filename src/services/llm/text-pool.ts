/**
 * Multi-provider *text* completion pool — the text sibling of the vision-OCR
 * pool (`services/ocr/per-page-pool.ts`). Reuses the same free-tier providers
 * (Gemini → Groq → Mistral → OpenRouter → SambaNova), the same env key prefixes,
 * and the same per-model fallback chains, but sends a text-only prompt (no image
 * part) and returns the raw model text plus the reported prompt-token count.
 *
 * This is the "use any available agent; if one is rate-limited, use the next"
 * primitive that non-OCR features (pre-submit sanity gate, failure triage,
 * selector-mapping assist, run summarization, data normalization) call through
 * `complete.ts`. Rate-limit accounting, key rotation, and admission control are
 * shared with OCR via `usage-tracker.ts` (same `cacheDir` → same per-key/model
 * daily budget), so text and OCR never blow each other's free-tier quota.
 *
 * The provider set + limits + model chains live in `../ocr/provider-limits.ts`;
 * override any chain with `OCR_<PROVIDER>_MODELS`. A pool entry's `callText`
 * throws `OcrHttpError` (status + headers + body) on a non-2xx so the shared
 * classifier (`../ocr/rate-limit-headers.ts`) can extract the precise retry
 * signal — identical to the vision path.
 */
import {
  type ModelSpec,
  type VisionProviderId,
  providerConfig,
  resolveModelChain,
  visionProviderConfigs,
} from "../ocr/provider-limits.js";
import { OcrHttpError } from "../ocr/rate-limit-headers.js";

/** Provider family id — shared with the vision pool (same key/limit registry). */
export type LlmProviderId = VisionProviderId;

export interface TextCallOutcome {
  /** Raw text the model returned (JSON when `json` was requested — parse upstream). */
  text: string;
  /** Prompt tokens the provider reported, for TPM reconciliation (undefined if absent). */
  promptTokens?: number;
}

export interface TextPoolKey {
  /** Stable id for logging — e.g. `"gemini-1"`, `"groq-2"`. Never the key value. */
  id: string;
  providerId: LlmProviderId;
  /** 1-based index within the provider's key set. */
  keyIndex: number;
  /** Raw key value — used for in-memory usage tracking only. Never log this. */
  rotationKey: string;
  /** This provider's model fallback chain (first = primary). */
  models: ModelSpec[];
  /** Provider priority (lower = preferred). */
  priority: number;
  /** Run a text completion on a specific model. Returns text + token usage. */
  callText(prompt: string, model: string, opts: { json: boolean }): Promise<TextCallOutcome>;
}

// ─── Env reading (mirrors per-page-pool.readKeys) ─────────────

function readKeys(prefix: string, max = 8): string[] {
  const out: string[] = [];
  const first = (process.env[prefix] ?? "").trim();
  if (first) out.push(first);
  for (let i = 2; i <= max; i++) {
    const v = (process.env[`${prefix}${i}`] ?? "").trim();
    if (v) out.push(v);
  }
  return out;
}

// ─── Provider call implementations (text-only) ────────────────

async function callGeminiText(
  apiKey: string,
  prompt: string,
  model: string,
  json: boolean,
): Promise<TextCallOutcome> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          ...(json ? { responseMimeType: "application/json" } : {}),
        },
      }),
    },
  );
  const bodyText = await resp.text();
  if (!resp.ok) throw new OcrHttpError("gemini", resp.status, resp.headers, bodyText);
  const data = JSON.parse(bodyText) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number };
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return { text, promptTokens: data.usageMetadata?.promptTokenCount };
}

async function callOpenAICompatText(args: {
  provider: LlmProviderId;
  endpoint: string;
  apiKey: string;
  model: string;
  prompt: string;
  json: boolean;
}): Promise<TextCallOutcome> {
  const body: Record<string, unknown> = {
    model: args.model,
    messages: [{ role: "user", content: args.prompt }],
    temperature: 0,
  };
  if (args.json) body.response_format = { type: "json_object" };
  const resp = await fetch(args.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${args.apiKey}` },
    body: JSON.stringify(body),
  });
  const raw = await resp.text();
  if (!resp.ok) throw new OcrHttpError(args.provider, resp.status, resp.headers, raw);
  const data = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  return { text, promptTokens: data.usage?.prompt_tokens };
}

// ─── Pool builder ─────────────────────────────────────────────

/**
 * Read every supported provider's keys out of `process.env` and return a flat
 * text pool ordered by provider priority. Each entry carries that provider's
 * model fallback chain. Empty if no keys are configured (caller decides whether
 * that is fatal or a graceful "no LLM available" no-op). Disable a provider by
 * unsetting its keys.
 */
export function buildTextPool(): TextPoolKey[] {
  const pool: TextPoolKey[] = [];
  for (const cfg of visionProviderConfigs()) {
    const keys = readKeys(cfg.keyEnvPrefix);
    if (keys.length === 0) continue;
    const models = resolveModelChain(cfg);
    keys.forEach((key, i) => {
      const idx = i + 1;
      pool.push({
        id: `${cfg.id}-${idx}`,
        providerId: cfg.id,
        keyIndex: idx,
        rotationKey: key,
        models,
        priority: cfg.priority,
        callText: (prompt, model, opts) =>
          cfg.id === "gemini"
            ? callGeminiText(key, prompt, model, opts.json)
            : callOpenAICompatText({
                provider: cfg.id,
                endpoint: cfg.endpoint!,
                apiKey: key,
                model,
                prompt,
                // Some OpenAI-compatible providers (Groq) do not support
                // response_format; gate JSON mode on the provider's declared
                // capability the same way the vision pool does.
                json: opts.json && cfg.jsonMode,
              }),
      });
    });
  }
  return pool;
}

/** Default model chain for a provider id (used when a TextPoolKey omits `models`). */
export function defaultModelChain(provider: LlmProviderId): ModelSpec[] {
  const cfg = providerConfig(provider);
  return cfg ? resolveModelChain(cfg) : [];
}

/** Describe the pool composition for log lines (no key material). */
export function summarizeTextPool(pool: TextPoolKey[]): string {
  const grouped = Object.groupBy(pool, (k) => k.providerId);
  const parts = Object.entries(grouped).map(([p, keys]) => `${p}=${keys!.length}`);
  return parts.length > 0 ? parts.join(" ") : "(empty)";
}
