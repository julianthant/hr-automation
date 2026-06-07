/**
 * Multi-provider vision-OCR key pool. Used by `runOcrPerPage` to fan pages out
 * across every available API key — and every model in each provider's fallback
 * chain — in parallel. Gemini primary, then Groq / Mistral / OpenRouter /
 * SambaNova (OpenAI-compatible). A 100-page PDF finishes in roughly
 * `ceil(pages / pool.length)` rounds instead of one-at-a-time.
 *
 * The pool is built from `process.env` at call time; only providers with keys
 * configured show up. Each entry is a `PoolKey` (one provider+key) carrying that
 * provider's model fallback chain. `callOcr(imagePath, prompt, model)` runs OCR
 * with a specific model and returns `{ json, promptTokens }`. On a non-2xx it
 * throws `OcrHttpError` (status + headers + body) so the per-page runner can
 * extract the exact retry delay and feed the usage tracker.
 *
 * Models, limits, and the provider set live in `provider-limits.ts`; override
 * any chain via `OCR_<PROVIDER>_MODELS` (comma-separated) env.
 */
import fs from "node:fs/promises";
import { log } from "../../utils/log.js";
import { parseJsonLoose } from "./env-keys.js";
import {
  type ModelSpec,
  type VisionProviderId,
  providerConfig,
  resolveModelChain,
  visionProviderConfigs,
} from "./provider-limits.js";
import { OcrHttpError } from "./rate-limit-headers.js";

export interface OcrCallOutcome {
  /** Parsed JSON from the model (array of records, or an object the runner unwraps). */
  json: unknown;
  /** Prompt tokens the provider reported, for TPM reconciliation. */
  promptTokens?: number;
}

export interface PoolKey {
  /** Stable id for logging — e.g. `"gemini-1"`, `"groq-2"`. */
  id: string;
  /** Provider family. */
  providerId: VisionProviderId;
  /** 1-based index within the provider's key set. */
  keyIndex: number;
  /** Raw key value — used for in-memory usage tracking only. Never log this. */
  rotationKey: string;
  /** This provider's model fallback chain (first = primary). */
  models: ModelSpec[];
  /** Provider priority (lower = preferred). */
  priority: number;
  /** Run OCR on a single PNG with a specific model. Returns parsed JSON + token usage. */
  callOcr(imagePath: string, prompt: string, model: string): Promise<OcrCallOutcome>;
}

// ─── Env reading ─────────────────────────────────────────────

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

// ─── Response summarization ──────────────────────────────────

/**
 * One-line, operator-readable summary of a model's parsed OCR response — the
 * record count plus each record's form kind + person name. Replaces dumping the
 * raw JSON array into the log line (unreadable, clipped at the panel edge). The
 * full data still rides through to the OCR review pane; the log just summarizes.
 */
export function summarizeOcrResponse(json: unknown): string {
  const records = Array.isArray(json) ? json : json == null ? [] : [json];
  if (records.length === 0) return "0 records";
  const SHOWN = 4;
  const parts = records.slice(0, SHOWN).map(describeOcrRecord);
  const extra = records.length - SHOWN;
  const head = `${records.length} record${records.length === 1 ? "" : "s"}`;
  const suffix = extra > 0 ? ` · +${extra} more` : "";
  return `${head} · ${parts.join(" · ")}${suffix}`;
}

/** `formKind: name` for one OCR record, defensively narrowing unknown shapes. */
function describeOcrRecord(rec: unknown): string {
  if (!rec || typeof rec !== "object") return "—";
  const r = rec as Record<string, unknown>;
  const kind = typeof r.formKind === "string" && r.formKind.trim() ? r.formKind.trim() : null;
  const name =
    (typeof r.printedName === "string" && r.printedName.trim()) ||
    (typeof r.employeeId === "string" && r.employeeId.trim()) ||
    "—";
  return kind ? `${kind}: ${name}` : name;
}

/**
 * Parse a model's text response. On failure, surface a readable warn (with the
 * truncated raw output for debugging) before rethrowing — so a malformed model
 * reply is diagnosable without the raw JSON cluttering every successful run.
 */
function parseOcrResponse(provider: VisionProviderId, model: string, text: string): unknown {
  try {
    return parseJsonLoose(text);
  } catch (err) {
    log.warn(
      `[ocr/${provider}] ${model} returned unparseable output (${text.length}c): ${text.slice(0, 200).replace(/\n/g, " ")}`,
    );
    throw err;
  }
}

// ─── Provider call implementations ───────────────────────────

async function callGemini(apiKey: string, imagePath: string, prompt: string, model: string): Promise<OcrCallOutcome> {
  const png = await fs.readFile(imagePath);
  log.step(`[ocr/gemini] page ${imagePath.split("/").pop()} → model=${model}, prompt=${prompt.length}c, image=${png.length}B`);
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { parts: [{ text: prompt }, { inline_data: { mime_type: "image/png", data: png.toString("base64") } }] },
        ],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
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
  const json = parseOcrResponse("gemini", model, text);
  log.success(`[ocr/gemini] ${model} → ${summarizeOcrResponse(json)}`);
  return { json, promptTokens: data.usageMetadata?.promptTokenCount };
}

async function callOpenAICompatVision(args: {
  provider: VisionProviderId;
  endpoint: string;
  apiKey: string;
  model: string;
  imagePath: string;
  prompt: string;
  jsonMode: boolean;
}): Promise<OcrCallOutcome> {
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
    temperature: 0,
  };
  if (args.jsonMode) body.response_format = { type: "json_object" };
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
  const json = parseOcrResponse(args.provider, args.model, text);
  log.success(`[ocr/${args.provider}] ${args.model} → ${summarizeOcrResponse(json)}`);
  return { json, promptTokens: data.usage?.prompt_tokens };
}

// ─── Pool builder ────────────────────────────────────────────

/**
 * Read every supported provider's keys out of `process.env` and return a flat
 * pool ordered by provider priority (Gemini → Groq → Mistral → OpenRouter →
 * SambaNova). Each entry carries that provider's model fallback chain. Empty if
 * no keys are configured. Disable a provider by unsetting its keys.
 */
export function buildVisionPool(): PoolKey[] {
  const pool: PoolKey[] = [];

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
        callOcr: (imagePath, prompt, model) =>
          cfg.id === "gemini"
            ? callGemini(key, imagePath, prompt, model)
            : callOpenAICompatVision({
                provider: cfg.id,
                endpoint: cfg.endpoint!,
                apiKey: key,
                model,
                imagePath,
                prompt,
                jsonMode: cfg.jsonMode,
              }),
      });
    });
  }

  return pool;
}

/** Default model chain for a provider id (used when a PoolKey omits `models`). */
export function defaultModelChain(provider: VisionProviderId): ModelSpec[] {
  const cfg = providerConfig(provider);
  return cfg ? resolveModelChain(cfg) : [];
}

/** Describe the pool composition for log lines (no key material). */
export function summarizePool(pool: PoolKey[]): string {
  const grouped = Object.groupBy(pool, (k) => k.providerId);
  const parts = Object.entries(grouped).map(([p, keys]) => `${p}=${keys!.length}`);
  return parts.length > 0 ? parts.join(" ") : "(empty)";
}
