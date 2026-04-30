# OCR Module — `src/ocr/`

Generic, schema-bound OCR primitive. Used by emergency-contact's prepare
phase; reusable by future workflows that need to extract structured data
from PDFs (or other documents the providers support).

Two execution paths share the same `OcrResult<T[]>` contract:

1. **Per-page parallel** (`pipeline.ts` → `per-page.ts`) — when a multi-
   provider key pool is configured, the PDF is split into per-page
   PNGs and every page is dispatched in parallel across all available
   keys (Gemini + Mistral + Groq + Sambanova). Default path for the
   prep workflows (emergency-contact + oath-signature).
2. **Whole-PDF cached** (`index.ts` → `ocrDocument`) — single Gemini
   call with the full PDF as inline `application/pdf`. Cache-keyed
   on PDF bytes + schema. Used as the fallback when per-page success
   < 50% or no pool keys are configured.

## Files

- `pipeline.ts` — `runOcrPipeline()` — picks per-page vs whole-PDF and
  unifies the result. The single entry point prep workflows should use.
- `per-page.ts` — `runOcrPerPage()` — fans pre-rendered PNGs across the
  multi-provider pool with round-robin dispatch + per-page failover.
- `per-page-pool.ts` — `buildVisionPool()` reads env vars and returns
  a flat `PoolKey[]` of every available vision-capable key across
  Gemini / Mistral / Groq / Sambanova. Pool composition is dynamic.
- `render-pages.ts` — `renderPdfPagesToPngs()` — `pdf-to-img` wrapper.
  Returns `[]` on render failure (caller falls back).
- `index.ts` — public `ocrDocument<T>()` whole-PDF orchestrator.
- `types.ts` — `OcrRequest`, `OcrResult`, `OcrProvider`, error classes.
- `cache.ts` — file cache at `.ocr-cache/{sha256}.json`.
- `rotation.ts` — per-key state machine + persisted state (used by
  the whole-PDF path; per-page path has its own simpler retry loop).
- `prompts.ts` — schema → Gemini prompt template.
- `providers/gemini.ts` — Gemini 2.5 Flash multi-modal call.

## Public API

```ts
import { ocrDocument } from "src/ocr";
import { z } from "zod/v4";

const Schema = z.array(z.object({ name: z.string(), age: z.number() }));
const result = await ocrDocument({
  pdfPath: "/path/to/scan.pdf",
  schema: Schema,
  schemaName: "Person", // used for cache key + prompt label
});
result.data; // validated T (here: { name; age }[])
result.cached; // true if served from cache
result.attempts; // how many provider calls were made
result.keyIndex; // which Gemini key succeeded (1..6)
```

## Cache

Key = `sha256(pdfBytes + schemaName + schemaJsonHash + promptVersion)`.
File: `.ocr-cache/{key}.json`. TTL: indefinite. To bust: pass
`bustCache: true`, or `rm .ocr-cache/*.json`.

## Rotation

`KeyRotation` tracks per-key `available | throttled | quota-exhausted | dead`
states, persisted at `.ocr-cache/rotation-state-{provider}.json`. The
day-rollover (UTC midnight) clears `quota-exhausted` and resets daily
counts. Throttle expiry is checked on each `pickNext()`.

Detection rules (Gemini error message patterns):

- `429` / "rate limit" / "too many" → throttled +60s
- "quota" / "exceed" / "exhaust" → quota-exhausted until next UTC midnight
- `401` / "unauthorized" / "invalid api key" → dead (this session)
- timeout / `ECONNRESET` / `EAI_AGAIN` → transient (5s throttle, then rotate)

## Providers

**Whole-PDF path** (`index.ts` / `OcrProvider` interface): Gemini only.
Adding a second whole-PDF provider would mean implementing `OcrProvider`
and registering in `index.ts`'s `getProvider()` selector — currently
deferred (no caller needs cross-provider whole-PDF fallback).

**Per-page path** (`per-page-pool.ts`): all four configured. Each
provider contributes one or more keys based on env vars set:

| Provider | Env var prefix | Default model | Override env |
|---|---|---|---|
| Gemini    | `GEMINI_API_KEY` (+`GEMINI_API_KEY2..6`)       | `gemini-2.5-flash`                              | `OCR_GEMINI_MODEL`     |
| Mistral   | `MISTRAL_API_KEY` (+`MISTRAL_API_KEY2..N`)     | `pixtral-12b-2409`                              | `OCR_MISTRAL_MODEL`    |
| Groq      | `GROQ_API_KEY` (+`GROQ_API_KEY2..N`)           | `meta-llama/llama-4-scout-17b-16e-instruct`     | `OCR_GROQ_MODEL`       |
| Sambanova | `SAMBANOVA_API_KEY` (+`SAMBANOVA_API_KEY2..N`) | `Llama-3.2-90B-Vision-Instruct`                 | `OCR_SAMBANOVA_MODEL`  |

Pool size = sum of all set keys across all providers. The per-page
driver dispatches `pages.length` work items with concurrency capped at
`min(pool.length, OCR_PAGE_CONCURRENCY ?? pool.length)`. Per-page
failover walks `OCR_PER_PAGE_MAX_RETRIES` (default 2) alternate keys
before marking the page failed; `pipeline.ts` then drops to the
whole-PDF path if `< 50%` of pages succeeded.

Cohere is the only key in the env that has no vision-capable model
exposed — it's intentionally not in the pool.

## Test recipe

```ts
import {
  __setCacheDirForTests,
  __setProviderForTests,
  ocrDocument,
} from "src/ocr";

beforeEach(() => __setCacheDirForTests(tmpDir));
afterEach(() => {
  __setCacheDirForTests(undefined);
  __setProviderForTests(undefined);
});

const fake = { id: "gemini", call: async () => happyResult(/* ... */) };
__setProviderForTests(fake);
```

## Lessons Learned

(empty — module is new as of 2026-04-28)
