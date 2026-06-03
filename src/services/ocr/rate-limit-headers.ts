/**
 * Parse precise retry timing out of provider rate-limit responses.
 *
 * The old limiter waited a flat 60s after any 429. Every provider actually
 * tells you when to retry — Groq/Mistral/OpenRouter via `Retry-After` and
 * `x-ratelimit-reset-*` headers, Gemini via a `RetryInfo.retryDelay` in the
 * error body. This module extracts that signal so the usage-tracker can throttle
 * a key for exactly as long as the server says, and distinguish a short per-minute
 * throttle (`rate-limit`) from a daily-quota wall (`quota-exhausted`).
 */
import type { VisionProviderId } from "./provider-limits.js";

export type RateLimitKind = "rate-limit" | "quota-exhausted" | "auth" | "transient" | "permanent";

export interface RateLimitInfo {
  kind: RateLimitKind;
  /** Precise wait derived from a server signal, in ms. Undefined → caller backs off. */
  retryAfterMs?: number;
}

/** Anything that exposes case-insensitive header lookup. */
export type HeaderBag = Headers | Record<string, string> | undefined;

function headerGet(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const rec = headers as Record<string, string>;
  const hit = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit ? rec[hit] : undefined;
}

/** Parse a `Retry-After` header (integer seconds or an HTTP date) → ms. */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const secs = Number(value.trim());
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.max(0, when - nowMs) : undefined;
}

/**
 * Parse a Go-style duration ("30s", "2970.938s", "1m30s", "49m30.9s", "500ms")
 * as used by Gemini's RetryInfo.retryDelay → ms.
 */
export function parseGoDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const s = value.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000); // bare seconds
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60_000 : n * 3_600_000;
  }
  return matched ? Math.round(total) : undefined;
}

/** Parse `X-RateLimit-Reset` — OpenRouter sends a Unix epoch in MILLISECONDS. */
function parseEpochReset(value: string | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const n = Number(value.trim());
  if (!Number.isFinite(n)) return undefined;
  // Heuristic: > 10^12 ⇒ ms epoch; ~10^9–10^10 ⇒ s epoch; else a relative delta in s.
  if (n > 1e12) return Math.max(0, n - nowMs);
  if (n > 1e9) return Math.max(0, n * 1000 - nowMs);
  return Math.max(0, n * 1000);
}

/** Gemini: scan the JSON error body for RetryInfo + quota metric. */
function classifyGemini(status: number, bodyText: string): RateLimitInfo {
  if (status === 401 || status === 403) {
    if (/quota|exhaust|RESOURCE_EXHAUSTED/i.test(bodyText)) return { kind: "quota-exhausted" };
    return { kind: "auth" };
  }
  if (status === 500 || status === 503 || status === 504) return { kind: "transient" };
  if (status === 429) {
    let retryAfterMs: number | undefined;
    let daily = /daily|per\s*day|generate_content_(?:free_tier_)?requests.*day/i.test(bodyText);
    try {
      const parsed = JSON.parse(bodyText) as {
        error?: { details?: Array<Record<string, unknown>>; message?: string };
      };
      const details = parsed.error?.details ?? [];
      for (const d of details) {
        const type = String(d["@type"] ?? "");
        if (type.endsWith("RetryInfo")) retryAfterMs = parseGoDuration(String(d.retryDelay ?? ""));
        const meta = (d.metadata ?? {}) as Record<string, unknown>;
        const metric = String(meta.quota_metric ?? "");
        const reason = String(d.reason ?? "");
        if (/daily/i.test(metric) || reason === "QUOTA_EXHAUSTED") daily = true;
      }
      if (parsed.error?.message && /reset after|per day|daily/i.test(parsed.error.message)) {
        // "Your quota will reset after 49m30s" — large delay ⇒ daily.
      }
    } catch {
      // Non-JSON body — fall through to status-only classification.
    }
    // A long retry (minutes+) almost always means a daily wall, not a per-minute throttle.
    if (retryAfterMs != null && retryAfterMs > 5 * 60_000) daily = true;
    return { kind: daily ? "quota-exhausted" : "rate-limit", retryAfterMs };
  }
  return { kind: "permanent" };
}

/** OpenAI-compatible providers (Groq, Mistral, OpenRouter, SambaNova). */
function classifyOpenAICompat(
  status: number,
  headers: HeaderBag,
  bodyText: string,
  nowMs: number,
): RateLimitInfo {
  if (status === 401 || status === 403) return { kind: "auth" };
  if (status === 402) return { kind: "quota-exhausted" }; // OpenRouter: out of credits.
  if (status === 408 || status === 500 || status === 502 || status === 503 || status === 504) {
    return { kind: "transient" };
  }
  if (status === 429) {
    const retryAfter =
      parseRetryAfter(headerGet(headers, "retry-after"), nowMs) ??
      parseEpochReset(headerGet(headers, "x-ratelimit-reset"), nowMs) ??
      // Groq/Mistral per-axis resets (seconds or Go-duration).
      parseGoDuration(headerGet(headers, "x-ratelimit-reset-tokens")) ??
      parseGoDuration(headerGet(headers, "x-ratelimit-reset-requests"));
    // `limit_rpd` (OpenRouter) / "per day" text ⇒ daily wall.
    const daily = /limit_rpd|per\s*day|daily|quota/i.test(bodyText);
    return { kind: daily ? "quota-exhausted" : "rate-limit", retryAfterMs: retryAfter };
  }
  return { kind: "permanent" };
}

export interface RawResponseMeta {
  status: number;
  headers?: HeaderBag;
  body?: string;
}

/**
 * Thrown by pool `callOcr` implementations on a non-2xx response so the per-page
 * runner can classify it with the real status/headers/body instead of regexing a
 * message. Carries the provider so the right header dialect is parsed.
 */
export class OcrHttpError extends Error {
  override name = "OcrHttpError";
  constructor(
    public provider: VisionProviderId,
    public status: number,
    public headers: HeaderBag,
    public body: string,
  ) {
    super(`${provider} OCR HTTP ${status}: ${body.slice(0, 200).replace(/\s+/g, " ")}`);
  }
}

/** Convert any thrown error into a RateLimitInfo (precise if it's an OcrHttpError). */
export function errorToRateLimitInfo(
  provider: VisionProviderId,
  err: unknown,
  nowMs = Date.now(),
): RateLimitInfo {
  if (err instanceof OcrHttpError) {
    return classifyResponse(provider, { status: err.status, headers: err.headers, body: err.body }, nowMs);
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/401|unauthor|invalid\s*api\s*key/i.test(msg)) return { kind: "auth" };
  if (/quota|exhaust/i.test(msg)) return { kind: "quota-exhausted" };
  if (/429|rate.?limit|too many requests/i.test(msg)) return { kind: "rate-limit" };
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|abort|network|socket|timeout|5\d\d/i.test(msg)) return { kind: "transient" };
  return { kind: "permanent" };
}

/** Top-level: classify a raw provider response (or error) into a RateLimitInfo. */
export function classifyResponse(
  provider: VisionProviderId,
  meta: RawResponseMeta,
  nowMs: number,
): RateLimitInfo {
  const body = meta.body ?? "";
  if (provider === "gemini") return classifyGemini(meta.status, body);
  return classifyOpenAICompat(meta.status, meta.headers, body, nowMs);
}
