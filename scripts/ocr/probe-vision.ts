/**
 * OCR vision-callability probe — diagnostic, not part of the runtime path.
 *
 * `probe-providers.ts` confirms a key authenticates and lists models. That is
 * NOT the same as "this model is callable on my free tier" — a model can be
 * visible in /v1/models yet 402/403 on the free plan. This probe sends ONE real
 * image OCR request per candidate model (first key of each provider) and reports:
 *   - does the free tier actually run it,
 *   - did it read the text (proves vision works), and
 *   - prompt_tokens (real image-token cost → seeds the TPM buckets).
 *
 * Run:  tsx --env-file=.env scripts/ocr/probe-vision.ts [imagePath]
 * Default image: a dashboard screenshot (contains real UI text to OCR).
 */
import fs from "node:fs/promises";

const IMAGE_PATH = process.argv[2] ?? ".screenshots/08-ocr-tab.png";
const PROMPT =
  'Extract all visible text from this image. Respond ONLY with compact JSON: {"text":"<all text you can read>"}';
const TIMEOUT_MS = 60_000;

function firstKey(prefix: string): string {
  return (process.env[prefix] ?? "").trim();
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

interface VisionResult {
  model: string;
  ok: boolean;
  status: number | "error";
  promptTokens?: number;
  snippet?: string;
  note?: string;
}

function snippetOf(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 90 ? `${t.slice(0, 90)}…` : t;
}

async function probeGeminiModel(key: string, model: string, b64: string, mime: string): Promise<VisionResult> {
  try {
    const resp = await timedFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: b64 } }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 512 },
        }),
      },
    );
    const body = await resp.text();
    if (!resp.ok) return { model, ok: false, status: resp.status, note: body.slice(0, 140).replace(/\s+/g, " ") };
    const data = JSON.parse(body) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number };
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return { model, ok: true, status: resp.status, promptTokens: data.usageMetadata?.promptTokenCount, snippet: snippetOf(text) };
  } catch (err) {
    return { model, ok: false, status: "error", note: err instanceof Error ? err.message : String(err) };
  }
}

async function probeOpenAICompatModel(args: {
  endpoint: string;
  key: string;
  model: string;
  b64: string;
  mime: string;
  jsonMode: boolean;
}): Promise<VisionResult> {
  const { endpoint, key, model, b64, mime, jsonMode } = args;
  try {
    const body: Record<string, unknown> = {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 512,
    };
    if (jsonMode) body.response_format = { type: "json_object" };
    const resp = await timedFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const raw = await resp.text();
    if (!resp.ok) return { model, ok: false, status: resp.status, note: raw.slice(0, 140).replace(/\s+/g, " ") };
    const data = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return { model, ok: true, status: resp.status, promptTokens: data.usage?.prompt_tokens, snippet: snippetOf(text) };
  } catch (err) {
    return { model, ok: false, status: "error", note: err instanceof Error ? err.message : String(err) };
  }
}

async function openRouterFreeVisionModels(key: string): Promise<string[]> {
  try {
    const resp = await timedFetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      data?: Array<{
        id?: string;
        architecture?: { input_modalities?: string[] };
        pricing?: { prompt?: string };
      }>;
    };
    return (data.data ?? [])
      .filter(
        (m) =>
          (m.architecture?.input_modalities ?? []).includes("image") &&
          (m.id?.endsWith(":free") || m.pricing?.prompt === "0"),
      )
      .map((m) => m.id ?? "")
      .filter(Boolean)
      .slice(0, 4);
  } catch {
    return [];
  }
}

async function runSequential(models: string[], fn: (m: string) => Promise<VisionResult>): Promise<VisionResult[]> {
  const out: VisionResult[] = [];
  for (const m of models) out.push(await fn(m));
  return out;
}

async function main() {
  const png = await fs.readFile(IMAGE_PATH);
  const b64 = png.toString("base64");
  const mime = IMAGE_PATH.endsWith(".jpg") || IMAGE_PATH.endsWith(".jpeg") ? "image/jpeg" : "image/png";

  console.log(`\n══ OCR VISION-CALLABILITY PROBE ══  image=${IMAGE_PATH} (${(png.length / 1024).toFixed(0)} KB, ${b64.length} b64 chars)\n`);

  const geminiKey = firstKey("GEMINI_API_KEY");
  const groqKey = firstKey("GROQ_API_KEY");
  const mistralKey = firstKey("MISTRAL_API_KEY");
  const sambaKey = firstKey("SAMBANOVA_API_KEY");
  const orKey = firstKey("OPEN_ROUTER_API_KEY");

  const orFree = orKey ? await openRouterFreeVisionModels(orKey) : [];

  const sections: Array<{ provider: string; results: VisionResult[] }> = await Promise.all([
    runSequential(
      ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-flash-preview", "gemini-3.5-flash", "gemini-3.1-flash-lite"],
      (m) => probeGeminiModel(geminiKey, m, b64, mime),
    ).then((results) => ({ provider: "gemini", results })),

    runSequential(["meta-llama/llama-4-scout-17b-16e-instruct"], (m) =>
      probeOpenAICompatModel({ endpoint: "https://api.groq.com/openai/v1/chat/completions", key: groqKey, model: m, b64, mime, jsonMode: false }),
    ).then((results) => ({ provider: "groq", results })),

    runSequential(["mistral-medium-latest", "ministral-8b-latest", "mistral-small-latest"], (m) =>
      probeOpenAICompatModel({ endpoint: "https://api.mistral.ai/v1/chat/completions", key: mistralKey, model: m, b64, mime, jsonMode: true }),
    ).then((results) => ({ provider: "mistral", results })),

    runSequential(["Llama-4-Maverick-17B-128E-Instruct", "gemma-3-12b-it", "gemma-4-31B-it"], (m) =>
      probeOpenAICompatModel({ endpoint: "https://api.sambanova.ai/v1/chat/completions", key: sambaKey, model: m, b64, mime, jsonMode: true }),
    ).then((results) => ({ provider: "sambanova", results })),

    runSequential(orFree, (m) =>
      probeOpenAICompatModel({ endpoint: "https://openrouter.ai/api/v1/chat/completions", key: orKey, model: m, b64, mime, jsonMode: false }),
    ).then((results) => ({ provider: `openrouter (free vision: ${orFree.length})`, results })),
  ]);

  for (const sec of sections) {
    console.log(`▌ ${sec.provider.toUpperCase()}`);
    if (sec.results.length === 0) console.log("    (no models tested)");
    for (const r of sec.results) {
      const flag = r.ok ? "✅ OK  " : "❌ FAIL";
      const tok = r.promptTokens != null ? `${r.promptTokens} img-tok` : "";
      console.log(`    ${flag} [${r.status}] ${r.model}  ${tok}`);
      if (r.ok && r.snippet) console.log(`           read: ${r.snippet}`);
      if (!r.ok && r.note) console.log(`           err:  ${r.note}`);
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error("vision probe failed:", err);
  process.exit(1);
});
