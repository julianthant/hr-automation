# OCR Module — `src/ocr/`

Generic, schema-bound OCR primitive. Used by emergency-contact's prepare
phase; reusable by future workflows that need to extract structured data
from PDFs (or other documents the providers support).

## Files

- `index.ts` — public `ocrDocument<T>()` orchestrator.
- `types.ts` — `OcrRequest`, `OcrResult`, `OcrProvider`, error classes.
- `cache.ts` — file cache at `.ocr-cache/{sha256}.json`.
- `rotation.ts` — per-key state machine + persisted state.
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

Currently: Gemini only. Cross-provider fallback (Mistral, OpenRouter,
Groq, Cerebras, Cohere, Sambanova) is deferred — to add a provider,
implement `OcrProvider` and register it in `index.ts`'s `getProvider()`
selector.

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
