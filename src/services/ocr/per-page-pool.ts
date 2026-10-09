/**
 * Multi-provider vision-OCR key pool. Used by `runOcrPerPage` to fan pages out
 * across every available API key — and every model in each provider's fallback
 * chain — in parallel. Gemini primary, then Groq / Mistral / OpenRouter /
 * SambaNova (OpenAI-compatible). A 100-page PDF finishes in roughly
 * `ceil(pages / pool.length)` rounds instead of one-at-a-time.
 *
 * The pool is built from `process.env` at call time; only providers with keys
 * configured show up. Each entry is a `PoolKey` (one provider+key) carrying that
 * provider's model fallback chain. `callOcr(imagePath, prompt, model, signal?,
 * ctx?)` runs OCR with a specific model and returns `{ json, promptTokens }`.
 * On a non-2xx it throws `OcrHttpError` (status + headers + body) so the
 * per-page runner can extract the exact retry delay and feed the usage tracker.
 * The optional `ctx` (`OcrCallContext`) carries the page/key/tier/attempt the
 * runner knows but the provider call does not — log correlation only, never
 * behavior.
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

/**
 * Per-attempt context the per-page runner knows but the provider call does not.
 * Purely for log correlation: without the page number the "→ N records" line
 * cannot be tied back to the "page N → model=…" line above it, because pages
 * run concurrently and their lines interleave. Tier is here because model tier
 * is a correctness control on this codebase (a tier-2 read of handwriting is
 * suspect), so "which tier read this page" must be visible in the run log.
 */
export interface OcrCallContext {
  /** Real document page number (NOT the slot index — a subset re-read differs). */
  page?: number;
  /** Pool entry id, e.g. `gemini-2`. */
  keyId?: string;
  /** Model accuracy tier (`ModelSpec.tier`); 1 = trusted on handwriting. */
  tier?: number;
  /** 1-based attempt number for this page. */
  attempt?: number;
  /** Why the previous attempt fell through, e.g. `gemini-1 rate-limited`. */
  retryReason?: string;
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
  callOcr(
    imagePath: string,
    prompt: string,
    model: string,
    signal?: AbortSignal,
    ctx?: OcrCallContext,
  ): Promise<OcrCallOutcome>;
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

/** Coerce a model response into a record list. A bare object is one record. */
function toRecordList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json == null) return [];
  return [json];
}

/** `"0 records"` / `"1 record"` / `"3 records"` — the success line's headline. */
export function summarizeOcrRecordCount(json: unknown): string {
  const n = toRecordList(json).length;
  return `${n} record${n === 1 ? "" : "s"}`;
}

/** Max per-record detail lines logged for one page before collapsing the tail. */
const RECORD_DETAIL_LINES = 6;

/**
 * One operator-readable detail line per extracted record — form kind, person
 * name, and a per-field read/illegible/blank mark. Never dumps raw JSON (the
 * old behavior: unreadable, clipped at the panel edge), and never logs a field
 * VALUE for an identifier: `ssn ✓` says the model read it, without putting a
 * real SSN in the audit log. The full data still rides through to the review
 * pane; this is the run log's account of what each page produced.
 *
 * Field marks are what make a weak-tier misread visible in the log at all —
 * a `ssn ✗ illegible` is the model admitting it could not read, which is the
 * signal the i9 trust model is built on (see `forms/i9.ts`).
 */
export function describeOcrRecords(json: unknown): string[] {
  const records = toRecordList(json);
  const shown = records.slice(0, RECORD_DETAIL_LINES).map(describeOcrRecord);
  const extra = records.length - RECORD_DETAIL_LINES;
  if (extra > 0) shown.push(`+${extra} more record${extra === 1 ? "" : "s"}`);
  return shown;
}

/** Read `obj[key]` as a non-blank trimmed string, or null. Safe on unknown shapes. */
function nestedString(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The field name a probe path addresses — what `illegible[]` entries are keyed on. */
function lastSegment(path: string[]): string {
  return path[path.length - 1];
}

/** Walk a dotted path over unknown shapes. Returns `undefined` if any hop misses. */
function readPath(rec: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = rec;
  for (const seg of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Does `path` exist on the record at all (even holding null)? */
function pathPresent(rec: Record<string, unknown>, path: string[]): boolean {
  let cur: unknown = rec;
  for (let i = 0; i < path.length - 1; i++) {
    if (!cur || typeof cur !== "object") return false;
    cur = (cur as Record<string, unknown>)[path[i]];
  }
  return Boolean(cur) && typeof cur === "object" && lastSegment(path) in (cur as object);
}

/** A string array field (`illegible` / `originallyMissing`), tolerant of junk. */
function stringArray(rec: Record<string, unknown>, key: string): string[] {
  const v = rec[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

interface FieldProbe {
  label: string;
  path: string[];
}

/**
 * Identity-bearing fields worth a mark, grouped by the record's form kind.
 *
 * Grouping is load-bearing, not cosmetic: the i9 record schema carries EVERY
 * field on EVERY record (a Section 1 record holds `section2Name: null`, a
 * Section 2 sheet holds `ssn: null`), so probing one flat list would log three
 * hollow marks on every line for fields that record never owned. A record is
 * only marked on the fields its own kind is responsible for.
 */
const I9_SECTION1_PROBES: readonly FieldProbe[] = [
  { label: "ssn", path: ["ssn"] },
  { label: "dob", path: ["dateOfBirth"] },
];

const I9_SHEET_PROBES: readonly FieldProbe[] = [
  { label: "name", path: ["lastName"] },
  { label: "ssn", path: ["ssn"] },
  { label: "hired", path: ["hireDate"] },
];

/** oath / emergency-contact / verify shapes. Two `eid` probes: oath carries it top-level, EC nests it. */
const GENERAL_PROBES: readonly FieldProbe[] = [
  { label: "eid", path: ["employeeId"] },
  { label: "eid", path: ["employee", "employeeId"] },
  { label: "signed", path: ["employeeSigned"] },
  { label: "official", path: ["officerSigned"] },
  { label: "contact", path: ["emergencyContact", "name"] },
  { label: "phone", path: ["emergencyContact", "phone"] },
  { label: "addr", path: ["emergencyContact", "address"] },
];

/** The fields a record of this kind is responsible for. */
function probesForKind(kind: string | null): readonly FieldProbe[] {
  if (kind === "i9 §1") return I9_SECTION1_PROBES;
  if (kind === "i9 §2" || kind === "i9 ssn") return I9_SHEET_PROBES;
  return GENERAL_PROBES;
}

/** `ssn ✓` / `ssn ✗ illegible` / `ssn ∅ blank` / `signed ✗` for one field. */
function markField(
  rec: Record<string, unknown>,
  probe: FieldProbe,
  illegible: string[],
  missing: string[],
): string | null {
  const key = lastSegment(probe.path);
  const flaggedIllegible = illegible.includes(key);
  if (!pathPresent(rec, probe.path) && !flaggedIllegible) return null;
  const v = readPath(rec, probe.path);
  // A boolean field answers a yes/no question about the paper (was it signed?),
  // so `false` is a real READ, not a failure to read — never an illegible mark.
  if (typeof v === "boolean") return `${probe.label} ${v ? "✓" : "✗"}`;
  const filled =
    (typeof v === "string" && v.trim() !== "") ||
    (typeof v === "number" && Number.isFinite(v)) ||
    (v !== null && typeof v === "object" && Object.keys(v).length > 0);
  if (filled) return `${probe.label} ✓`;
  if (flaggedIllegible) return `${probe.label} ✗ illegible`;
  if (missing.includes(key)) return `${probe.label} ∅ blank`;
  return `${probe.label} —`;
}

/** `i9 §1` / `i9 §2` / `i9 ssn` / `oath` / `emergency-contact` — the record's form label. */
function describeRecordKind(r: Record<string, unknown>): string | null {
  const kind = typeof r.formKind === "string" && r.formKind.trim() ? r.formKind.trim() : null;
  if (kind === "i9 section 1" || kind === "i9") return "i9 §1"; // "i9" = legacy rows
  if (kind === "i9 section 2") return "i9 §2";
  // Legacy sheet rows were classified `unknown` with the sheet name in
  // `section2Name` — still the trust oracle, not a filler page.
  if (nestedString(r, "section2Name")) return "i9 §2";
  return kind;
}

/** Compose an i9 Section 1 name from its separate paper fields. */
function i9Name(r: Record<string, unknown>): string | null {
  const last = nestedString(r, "lastName");
  const first = nestedString(r, "firstName");
  const mi = nestedString(r, "middleInitial");
  if (!last && !first) return null;
  const given = [first, mi].filter(Boolean).join(" ");
  if (last && given) return `${last}, ${given}`;
  return last ?? given;
}

/** `<kind> · <name> · <field marks> [· illegible: <name fields>]` for one record. */
function describeOcrRecord(rec: unknown): string {
  if (!rec || typeof rec !== "object") return "—";
  const r = rec as Record<string, unknown>;
  const illegible = stringArray(r, "illegible");
  const missing = stringArray(r, "originallyMissing");

  // Oath records carry the name at top level (printedName); EC records nest it
  // under employee.name (or emergencyContact.name on a contact-only page); i9
  // splits it across lastName/firstName/middleInitial. Fall back across all of
  // them + the EID so no shape logs as a bare `—`.
  const name =
    i9Name(r) ||
    nestedString(r, "printedName") ||
    nestedString(r.employee, "name") ||
    nestedString(r, "section2Name") ||
    nestedString(r.emergencyContact, "name") ||
    nestedString(r, "employeeId") ||
    nestedString(r.employee, "employeeId") ||
    "—";

  const kind = describeRecordKind(r);
  const probes = probesForKind(kind);
  const marks = probes
    .map((p) => markField(r, p, illegible, missing))
    .filter((m): m is string => m !== null);
  // Illegible NAME fields have no probe of their own (the name is rendered as
  // text, not a mark), so surface them explicitly — an unread name is exactly
  // the misread signature the second-opinion re-read exists to catch.
  const probed = new Set(probes.map((p) => lastSegment(p.path)));
  const otherIllegible = illegible.filter((f) => !probed.has(f));

  const parts = [kind, name, ...marks];
  if (otherIllegible.length > 0) parts.push(`illegible: ${otherIllegible.join(", ")}`);
  return parts.filter(Boolean).join(" · ");
}

// ─── Call-line formatting ────────────────────────────────────

/**
 * `page 10 · gemini-2 · gemini-3-flash-preview (tier 1)` — the call's identity.
 * Both the start and done lines lead with this SAME string, which is what pairs
 * them: pages run concurrently, so their lines interleave in the run log and
 * a done line with no page number could not be traced back to its request.
 *
 * `withRetry` appends the attempt + why the last cell fell through. Only the
 * start line carries it (the done line is already paired by the identity).
 */
function describeCall(model: string, ctx: OcrCallContext | undefined, withRetry = false): string {
  const parts: string[] = [];
  if (ctx?.page != null) parts.push(`page ${ctx.page}`);
  if (ctx?.keyId) parts.push(ctx.keyId);
  parts.push(ctx?.tier != null ? `${model} (tier ${ctx.tier})` : model);
  if (withRetry && ctx?.attempt != null && ctx.attempt > 1) {
    parts.push(ctx.retryReason ? `try ${ctx.attempt} (${ctx.retryReason})` : `try ${ctx.attempt}`);
  }
  return parts.join(" · ");
}

/** Human byte size for the request-line image field. */
function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;
}

/** Log the pre-call line: what we are about to send, and on which cell. */
function logOcrCallStart(
  provider: VisionProviderId,
  model: string,
  ctx: OcrCallContext | undefined,
  promptChars: number,
  imageBytes: number,
): void {
  log.step(
    `[ocr/${provider}] ${describeCall(model, ctx, true)} · prompt ${promptChars}c · img ${formatBytes(imageBytes)}`,
  );
}

/**
 * Log the post-call lines: one success line (same call identity as the start
 * line, so they pair even though concurrent pages interleave) plus one detail
 * line per extracted record.
 */
function logOcrCallDone(
  provider: VisionProviderId,
  model: string,
  ctx: OcrCallContext | undefined,
  json: unknown,
  elapsedMs: number,
  promptTokens: number | undefined,
): void {
  const meta = [`${(elapsedMs / 1000).toFixed(1)}s`];
  if (promptTokens != null) meta.push(`${promptTokens} tok`);
  log.success(
    `[ocr/${provider}] ${describeCall(model, ctx)} · ${meta.join(" · ")} · ${summarizeOcrRecordCount(json)}`,
  );
  for (const line of describeOcrRecords(json)) log.success(`[ocr/${provider}] └ ${line}`);
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

async function callGemini(
  apiKey: string,
  imagePath: string,
  prompt: string,
  model: string,
  signal?: AbortSignal,
  ctx?: OcrCallContext,
): Promise<OcrCallOutcome> {
  const png = await fs.readFile(imagePath, { signal });
  logOcrCallStart("gemini", model, ctx, prompt.length, png.length);
  const startedAt = Date.now();
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      signal,
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
  const promptTokens = data.usageMetadata?.promptTokenCount;
  logOcrCallDone("gemini", model, ctx, json, Date.now() - startedAt, promptTokens);
  return { json, promptTokens };
}

async function callOpenAICompatVision(args: {
  provider: VisionProviderId;
  endpoint: string;
  apiKey: string;
  model: string;
  imagePath: string;
  prompt: string;
  jsonMode: boolean;
  signal?: AbortSignal;
  ctx?: OcrCallContext;
}): Promise<OcrCallOutcome> {
  const png = await fs.readFile(args.imagePath, { signal: args.signal });
  logOcrCallStart(args.provider, args.model, args.ctx, args.prompt.length, png.length);
  const startedAt = Date.now();
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
    signal: args.signal,
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
  const promptTokens = data.usage?.prompt_tokens;
  logOcrCallDone(args.provider, args.model, args.ctx, json, Date.now() - startedAt, promptTokens);
  return { json, promptTokens };
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
        callOcr: (imagePath, prompt, model, signal, ctx) =>
          cfg.id === "gemini"
            ? callGemini(key, imagePath, prompt, model, signal, ctx)
            : callOpenAICompatVision({
                provider: cfg.id,
                endpoint: cfg.endpoint!,
                apiKey: key,
                model,
                imagePath,
                prompt,
                jsonMode: cfg.jsonMode,
                signal,
                ctx,
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
  const parts = Object.entries(grouped).map(([p, keys]) => `${p}=${keys.length}`);
  return parts.length > 0 ? parts.join(" ") : "(empty)";
}
