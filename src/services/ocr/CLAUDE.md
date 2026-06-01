# OCR Service

Schema-bound OCR primitive used by OCR-backed workflows. Prep workflows default to per-page parallel OCR across configured vision providers; whole-PDF OCR is operator-triggered only.

## Contracts

- `ocrDocument` returns `OcrResult<T[]>`; whole-PDF results are never cached.
- `.ocr-cache/` is retained only for provider key rotation state, not extracted OCR results.
- Per-page OCR dispatches pages across all configured keys/providers with concurrency capped by `OCR_PAGE_CONCURRENCY`.
- Per-page failures stay visible as failed pages; the pipeline should not silently fall back to whole-PDF on partial failure.
- Whole-PDF OCR is reached through `/api/ocr/reocr-whole-pdf`.
- Cohere is intentionally not in the vision pool.

## Key Rotation

`KeyRotation` persists provider key state at `<cacheDir>/rotation-state-{provider}.json`. The dashboard passes `runtimeDir(trackerDir)` and the default `cacheDir` is `.tracker/runtime`, so in normal operation the file lives at `.tracker/runtime/rotation-state-{provider}.json` (moved out of the `.tracker/` root in the 2026-06-01 tracker-dir restructure).

- 429/rate-limit text → throttled briefly.
- quota/exhaustion text → quota-exhausted until next UTC day.
- auth/invalid-key text → dead for this session.
- timeouts/network resets → transient throttle, then rotate.

Gemini text helpers used by OCR matching/disambiguation should share this rotation path, not hand-roll key loops.

## Providers

Whole-PDF path is Gemini-only. Per-page path uses configured keys for Gemini, Mistral, Groq, and Sambanova. Model names and overrides live in code/env; read the provider modules instead of copying them here.

## Tests

Use `__setCacheDirForTests` and `__setProviderForTests` to isolate cache paths and stub providers. Reset both after each test.

## Lessons Learned

- **2026-05-19: Oath approve payloads normalize OCR names before daemon enqueue.** Queue rows should show display-case names, while raw OCR records remain in prep payloads for review.
- **2026-05-18: Oath UPAY585 EIDs may be handwritten in the top page margin.** Prompts must scan the whole page, not only printed boxes.
- **2026-05-01: Per-page is the only auto path.** Failed pages surface to review; whole-PDF is a manual recovery action.
- **2026-05-03: Per-page runner injects rowIndex and employeeSigned defaults.** Provider omissions should not drop otherwise valid records.
- **2026-05-15: Disambiguation uses OCR key rotation.** Future Gemini text helpers should do the same.
