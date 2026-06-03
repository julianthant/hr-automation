/**
 * OCR provider key probe — diagnostic, not part of the runtime path.
 *
 * Hits each configured provider with each key found in the environment and
 * reports: (a) is the key valid/live, (b) which models the key can see, and
 * (c) whether the provider is usable for vision OCR at all. Never logs key
 * material — only a masked fingerprint and the provider/index.
 *
 * Run:  tsx --env-file=.env scripts/ocr/probe-providers.ts
 */

type Capability = "vision-ocr" | "traditional-ocr" | "text-only" | "non-ocr";

interface KeyResult {
  index: number;
  fingerprint: string;
  ok: boolean;
  status: number | "error";
  note: string;
  models?: string[];
}

interface ProviderReport {
  provider: string;
  capability: Capability;
  capabilityNote: string;
  keys: KeyResult[];
}

const TIMEOUT_MS = 20_000;

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

/** Last 4 chars only — enough to disambiguate keys without exposing them. */
function fingerprint(key: string): string {
  return key.length <= 4 ? "****" : `…${key.slice(-4)}`;
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

/** Generic OpenAI-compatible GET /v1/models probe. */
async function probeOpenAIModels(
  key: string,
  modelsUrl: string,
  pickModelIds: (data: unknown) => string[],
): Promise<Omit<KeyResult, "index" | "fingerprint">> {
  try {
    const resp = await timedFetch(modelsUrl, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, status: resp.status, note: body.slice(0, 160).replace(/\s+/g, " ") };
    }
    const data = await resp.json().catch(() => ({}));
    const models = pickModelIds(data);
    return { ok: true, status: resp.status, note: `${models.length} models`, models };
  } catch (err) {
    return { ok: false, status: "error", note: err instanceof Error ? err.message : String(err) };
  }
}

function openAiModelIds(data: unknown): string[] {
  const arr = (data as { data?: Array<{ id?: string }> })?.data ?? [];
  return arr.map((m) => m.id ?? "").filter(Boolean).sort();
}

// ─── Per-provider probes ─────────────────────────────────────

async function probeGemini(key: string) {
  try {
    const resp = await timedFetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`,
      { method: "GET" },
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, status: resp.status, note: body.slice(0, 160).replace(/\s+/g, " ") };
    }
    const data = (await resp.json().catch(() => ({}))) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const models = (data.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter((id) => id.includes("flash") || id.includes("pro"))
      .sort();
    return { ok: true, status: resp.status, note: `${(data.models ?? []).length} models`, models };
  } catch (err) {
    return { ok: false, status: "error" as const, note: err instanceof Error ? err.message : String(err) };
  }
}

async function probeOpenRouter(key: string) {
  // /api/v1/key validates the key AND returns usage + limits (the usage-tracking signal).
  try {
    const resp = await timedFetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await resp.text().catch(() => "");
    if (!resp.ok) {
      return { ok: false, status: resp.status, note: body.slice(0, 160).replace(/\s+/g, " ") };
    }
    const parsed = JSON.parse(body) as {
      data?: { label?: string; usage?: number; limit?: number | null; limit_remaining?: number | null; is_free_tier?: boolean };
    };
    const d = parsed.data ?? {};
    const note = `usage=$${d.usage ?? 0} limit=${d.limit ?? "∞"} remaining=${d.limit_remaining ?? "∞"} free=${d.is_free_tier ?? "?"}`;
    return { ok: true, status: resp.status, note };
  } catch (err) {
    return { ok: false, status: "error" as const, note: err instanceof Error ? err.message : String(err) };
  }
}

async function probeOcrSpace(key: string) {
  // Tiny 1x1 PNG (transparent). Validates the key; "no text found" still means the key is LIVE.
  const onePxPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  try {
    const form = new URLSearchParams();
    form.set("base64Image", `data:image/png;base64,${onePxPng}`);
    form.set("filetype", "PNG");
    const resp = await timedFetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const body = await resp.text().catch(() => "");
    const invalid = /invalid\s*api\s*key|not\s*a\s*valid/i.test(body);
    if (resp.status === 403 || invalid) {
      return { ok: false, status: resp.status, note: body.slice(0, 160).replace(/\s+/g, " ") };
    }
    return { ok: true, status: resp.status, note: "key accepted (parse endpoint reachable)" };
  } catch (err) {
    return { ok: false, status: "error" as const, note: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Provider registry ───────────────────────────────────────

interface ProviderSpec {
  provider: string;
  prefix: string;
  capability: Capability;
  capabilityNote: string;
  probe: (key: string) => Promise<Omit<KeyResult, "index" | "fingerprint">>;
}

const PROVIDERS: ProviderSpec[] = [
  {
    provider: "gemini",
    prefix: "GEMINI_API_KEY",
    capability: "vision-ocr",
    capabilityNote: "Native PDF + vision; primary OCR engine.",
    probe: probeGemini,
  },
  {
    provider: "openrouter",
    prefix: "OPEN_ROUTER_API_KEY",
    capability: "vision-ocr",
    capabilityNote: "Gateway to vision models + native-PDF / mistral-ocr plugin. Currently UNUSED in code.",
    probe: probeOpenRouter,
  },
  {
    provider: "mistral",
    prefix: "MISTRAL_API_KEY",
    capability: "vision-ocr",
    capabilityNote: "Dedicated /v1/ocr (mistral-ocr-latest) + vision chat. Code uses DEPRECATED pixtral.",
    probe: (k) =>
      probeOpenAIModels(k, "https://api.mistral.ai/v1/models", (d) =>
        openAiModelIds(d).filter((id) => /ocr|pixtral|medium|small|ministral|large/i.test(id)),
      ),
  },
  {
    provider: "groq",
    prefix: "GROQ_API_KEY",
    capability: "vision-ocr",
    capabilityNote: "Only vision model: llama-4-scout (preview).",
    probe: (k) =>
      probeOpenAIModels(k, "https://api.groq.com/openai/v1/models", (d) =>
        openAiModelIds(d).filter((id) => /scout|maverick|vision|llava/i.test(id)),
      ),
  },
  {
    provider: "sambanova",
    prefix: "SAMBANOVA_API_KEY",
    capability: "vision-ocr",
    capabilityNote: "Code default Llama-3.2-90B-Vision was REMOVED 2025-04. Live vision: Llama-4-Maverick / gemma-3.",
    probe: (k) =>
      probeOpenAIModels(k, "https://api.sambanova.ai/v1/models", (d) =>
        openAiModelIds(d).filter((id) => /vision|maverick|gemma|llama-4/i.test(id)),
      ),
  },
  {
    provider: "cohere",
    prefix: "COHERE_API_KEY",
    capability: "vision-ocr",
    capabilityNote: "command-a-vision now exists (images only). Code comment says intentionally excluded.",
    probe: (k) =>
      probeOpenAIModels(k, "https://api.cohere.com/v1/models", (d) => {
        const arr = (d as { models?: Array<{ name?: string }> })?.models ?? [];
        return arr.map((m) => m.name ?? "").filter((id) => /vision|command-a/i.test(id)).sort();
      }),
  },
  {
    provider: "cerebras",
    prefix: "CEREBRAS_API_KEY",
    capability: "text-only",
    capabilityNote: "NO vision input on any hosted model — cannot do image OCR. Text post-processing only.",
    probe: (k) => probeOpenAIModels(k, "https://api.cerebras.ai/v1/models", openAiModelIds),
  },
  {
    provider: "ocrspace",
    prefix: "OCRSPACE_API_KEY",
    capability: "traditional-ocr",
    capabilityNote: "Free tier 1MB / 3 pages — too small for heavy PDFs. Flat text only.",
    probe: probeOcrSpace,
  },
];

// Non-OCR services, classified without a live probe.
const NON_OCR = [{ provider: "zep", prefix: "ZEP_API_KEY", note: "Memory/context service — NOT an OCR provider." }];

async function main() {
  const reports: ProviderReport[] = [];

  await Promise.all(
    PROVIDERS.map(async (spec) => {
      const keys = readKeys(spec.prefix);
      const results = await Promise.all(
        keys.map(async (key, i): Promise<KeyResult> => {
          const r = await spec.probe(key);
          return { index: i + 1, fingerprint: fingerprint(key), ...r };
        }),
      );
      reports.push({
        provider: spec.provider,
        capability: spec.capability,
        capabilityNote: spec.capabilityNote,
        keys: results,
      });
    }),
  );

  reports.sort((a, b) => PROVIDERS.findIndex((p) => p.provider === a.provider) - PROVIDERS.findIndex((p) => p.provider === b.provider));

  const capIcon: Record<Capability, string> = {
    "vision-ocr": "✅ VISION-OCR",
    "traditional-ocr": "🔸 TEXT-OCR",
    "text-only": "⛔ NO-VISION",
    "non-ocr": "⛔ NON-OCR",
  };

  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log(" OCR PROVIDER KEY PROBE");
  console.log("══════════════════════════════════════════════════════════════════");

  for (const rep of reports) {
    const okCount = rep.keys.filter((k) => k.ok).length;
    console.log(`\n▌ ${rep.provider.toUpperCase()}  [${capIcon[rep.capability]}]  ${okCount}/${rep.keys.length} keys live`);
    console.log(`  ${rep.capabilityNote}`);
    for (const k of rep.keys) {
      const flag = k.ok ? "ok " : "DEAD";
      console.log(`    #${k.index} ${k.fingerprint}  [${flag} ${k.status}]  ${k.note}`);
      if (k.ok && k.models && k.models.length) {
        console.log(`         models: ${k.models.join(", ")}`);
      }
    }
  }

  console.log("\n──────────────────────────────────────────────────────────────────");
  for (const n of NON_OCR) {
    const keys = readKeys(n.prefix);
    console.log(`▌ ${n.provider.toUpperCase()}  [⛔ NON-OCR]  ${keys.length} key(s) present — ${n.note}`);
  }

  // Machine-readable summary for follow-up tooling.
  const summary = reports.map((r) => ({
    provider: r.provider,
    capability: r.capability,
    live: r.keys.filter((k) => k.ok).map((k) => k.index),
    dead: r.keys.filter((k) => !k.ok).map((k) => ({ index: k.index, status: k.status })),
  }));
  console.log("\n── JSON SUMMARY ──");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
