# OCR Per-Page Retry — Design Spec

**Date:** 2026-05-01
**Status:** Draft (pending user review)
**Scope:** Wire the OCR workflow to use the existing per-page primitive, surface failed pages in the dashboard, and add manual per-page retry plus a manual whole-PDF escape hatch.

## Background

`src/ocr/pipeline.ts` already implements per-page OCR: it renders the PDF to one PNG per page, fans pages across a multi-provider key pool (Gemini + Mistral + Groq + Sambanova) with concurrency = pool size, and does per-page failover across `OCR_PER_PAGE_MAX_RETRIES` (default 2) alternate keys before marking a page failed. When the per-page success ratio falls below 50% it falls back to a single Gemini call on the full PDF.

The OCR workflow's orchestrator (`src/workflows/ocr/orchestrator.ts:82`) bypasses this pipeline. It calls `realOcrDocument` directly — the whole-PDF Gemini path — so today every OCR run is one LLM call on the full document. If that call fails or times out, the entire row fails. There is no per-page granularity surfaced anywhere.

The dashboard's `OcrReviewPane` already groups records by `sourcePage` (`OcrReviewPane.tsx:126-134`), so the UI was designed assuming per-page output that the orchestrator isn't producing.

## Goals

1. **Default to per-page OCR.** Stop sending whole PDFs to one LLM call as the primary path.
2. **Surface page-level failures.** Operator sees which specific pages failed, with error message, attempt count, and providers tried.
3. **Manual per-page retry.** Operator clicks "Retry page N" on a failed page card; a mini-orchestrator re-runs OCR + match + eid-lookup + verification scoped to that one page and patches new records into the row.
4. **Whole-PDF as a manual escape hatch.** Keep `ocrDocument` reachable behind a confirmable "Re-OCR whole PDF" button on the row — never automatic — for the rare case where many pages fail and a holistic document view is the recovery path.

## Non-goals

- Splitting the source PDF into separate `.pdf` files on disk. The pipeline already renders to PNGs and sends those to the vision models; physical PDF splits add complexity with no functional gain.
- Surfacing schema-validation drops (`per-page.ts:179` silently drops records that fail the per-record Zod schema). Out of scope; could be a follow-up if it becomes a real issue.
- Auto-retry beyond what the per-page driver already does. The driver's `OCR_PER_PAGE_MAX_RETRIES` (default 2) covers transient pool-key failures; manual retry is the recovery for after that exhausts.
- Async/background retry. Retry endpoints are synchronous — the operator clicks, waits with a spinner, sees the row update.
- Migrating in-flight rows. Existing `awaiting-approval` rows from before this change have no `failedPages` field; the frontend treats absent `failedPages` as `[]` and the row renders exactly as today.

## Architecture overview

The orchestrator switches from `realOcrDocument` to `runOcrPipeline`. The pipeline gets one semantic change: the auto-fallback to whole-PDF on <50% success ratio is removed. Failed pages now propagate up to the orchestrator instead of triggering a hidden whole-PDF re-OCR. The whole-PDF code path stays in `ocrDocument` and remains reachable through a new manual endpoint.

The orchestrator factors out a `runOcrPhaseAndDownstream(input, opts)` helper covering OCR → match → eid-lookup → verification. The initial run calls it for the full PDF; per-page retry calls it for a single page (passing `retryPage: number` so OCR scope is one PNG and downstream ops touch only the new records). Both paths share the same code, including the existing `watchChildRuns` eid-lookup integration.

Two new HTTP endpoints in `src/tracker/ocr-http.ts` drive operator actions: `/api/ocr/retry-page` and `/api/ocr/reocr-whole-pdf`. Both acquire a per-row mutex (rejecting concurrent retries on the same row with 409). The OCR review pane gets a new `FailedPageCard` component rendered inline by `sourcePage` alongside successful records.

## Data model

The OCR row's `data` field gains failure tracking. New fields on the `awaiting-approval` tracker entry:

```ts
data.failedPages: Array<{
  page: number;                    // 1-indexed page number
  error: string;                   // last error message from the pool driver
  attemptedKeys: string[];         // pool key ids tried (e.g. ["gemini-1", "mistral-1", "groq-1"])
  pageImagePath: string;           // .tracker/page-images/<sessionId>/page-NN.png
  attempts: number;                // total OCR attempts across all retry clicks
}>;

data.pageStatusSummary: {
  total: number;                   // PDF page count
  succeeded: number;
  failed: number;
};
```

`failedPages` is derived from `PerPageOcrResult.pages` (already populated in `src/ocr/per-page.ts`). The orchestrator just plumbs that data through to the tracker entry — no new state in the OCR primitive.

A successful retry removes the page from `failedPages` and updates `records[]` by filtering out any records with `sourcePage === pageNum` and appending the new ones. Order in the array doesn't matter — the frontend groups by `sourcePage` via `Map` and renders in numeric order. A failed retry leaves the entry in `failedPages` with `attempts` incremented and `error` updated.

## Pipeline change

`src/ocr/pipeline.ts` today returns:

```ts
interface OcrPipelineResult<T> {
  data: T[];
  provider: string;
  attempts: number;
  cached: boolean;
  pageImagesDir: string;
}
```

After the change:

```ts
interface OcrPipelineResult<T> {
  data: T[];                                  // successful records only
  provider: string;
  attempts: number;
  cached: boolean;
  pageImagesDir: string;
  pages: Array<{                              // NEW — per-page status
    page: number;
    success: boolean;
    error?: string;
    attemptedKeys?: string[];
    poolKeyId?: string;                       // succeeded key, when success
  }>;
}
```

The `MIN_PER_PAGE_SUCCESS_RATIO` branch (lines 58, 121-135) is removed. The pipeline always returns the per-page result when per-page ran. **No auto-fallback to whole-PDF under any condition** — including the cases where the pipeline previously fell back automatically:

- **Zero pages rendered** (pdf-to-img failure): the orchestrator fails the row with error `"PDF page render failed — re-upload or use Re-OCR whole PDF"`. Operator recovers by clicking the manual escape hatch.
- **Pool empty** (no provider keys configured): the orchestrator fails the row with the existing pool-empty error message. Operator fixes the env and reuploads.

A new exported helper `runOcrWholePdf<T>(input)` wraps the existing `ocrDocument` call so the manual escape-hatch endpoint has a clean entry point. The auto-path (`runOcrPipeline`) never calls it.

## Orchestrator change

Today's `orchestrator.ts:82-95` block:

```ts
const runOcr = opts._ocrPipelineOverride ?? (async ({ pdfPath, spec: s }) => {
  const result = await realOcrDocument({ pdfPath, schema: s.ocrArraySchema, ... });
  return { data: result.data, provider: ..., attempts: ..., cached: ... };
});
```

becomes:

```ts
const runOcr = opts._ocrPipelineOverride ?? (async ({ pdfPath, spec: s, sessionId }) => {
  const pageImagesDir = path.join(trackerDir ?? ".tracker", "page-images", sessionId);
  const result = await runOcrPipeline({
    pdfPath,
    pageImagesDir,
    recordSchema: s.ocrRecordSchema,
    arraySchema: s.ocrArraySchema,
    schemaName: s.schemaName,
    prompt: s.prompt,
  });
  return result;  // includes pages[] for failure tracking
});
```

The `awaiting-approval` write at lines 284-301 is extended to include `failedPages` and `pageStatusSummary` derived from `result.pages`.

A new exported helper `runOcrRetryPage(input, opts)` runs the same OCR + match + eid-lookup + verification pipeline scoped to a single page. It loads the prior row's `records` and `failedPages` from the tracker, runs OCR for just that page's PNG, runs `spec.matchRecord` on new records, fans out eid-lookup for any that need it, and emits a fresh `awaiting-approval` tracker entry with the patched arrays. The existing carry-forward + force-research helpers are reused as-is.

## Endpoints

**`POST /api/ocr/retry-page`**
- Body: `{ sessionId: string, runId: string, pageNum: number }`
- Behavior: acquire per-row mutex; load the row; verify status is `awaiting-approval` (else 409); call `runOcrRetryPage`; release mutex.
- Returns: `{ ok: true, page, recordsAdded: number, stillFailed: boolean }` on success; `409` if a retry is in flight or the row's already approved/discarded; `410` if the page PNG is missing (cleanup ran, operator must reupload).

**`POST /api/ocr/reocr-whole-pdf`**
- Body: `{ sessionId: string, runId: string }`
- Behavior: acquire per-row mutex; call `runOcrWholePdf`; run match + carry-forward + eid-lookup + verification (full mini-orchestrator); **replace `records[]` entirely** + clear `failedPages`. Confirmation dialog on frontend before posting; this destroys per-record edits.
- Returns: `{ ok: true, recordCount, verifiedCount }`.

**Concurrency model:** module-level `Map<rowKey, Promise<void>>` where `rowKey = ${sessionId}:${runId}`. Both endpoints check + set in one tick before kicking off work. Same pattern as `force-research.ts`.

## UI changes

`OcrReviewPane.tsx` grouping (currently `useMemo` at lines 126-134) gets a parallel pass over `data.failedPages`. The rendered list is the union of successful page groups and failed page entries, sorted by page number — failed page 3 sits naturally between successful pages 2 and 4.

**New `FailedPageCard.tsx` component:**
- Header: `Page N of M in pile · OCR failed`
- Body: error message; attempt count (`Tried 3 times`); attempted-providers chip row showing `gemini` `mistral` `groq` `sambanova` chips for keys that were tried
- Actions: `Retry page` button (with `Loader2` spinner during POST); `Skip page` button (local-only acknowledgment that clears the visual emphasis — failed pages already contribute zero records to Approve, so this is purely visual)

**Header changes** in `OcrReviewPane.tsx`:
- When `failedPages.length > 0`: a small `Re-OCR whole PDF` button next to Cancel. Click opens a Radix `Dialog` confirming "This will discard all per-record edits. Continue?"
- Summary string in the header gains a failure count: existing `"5 verified · 2 needs review"` becomes `"5 verified · 2 needs review · 1 page failed"` when applicable.

The existing `Re-research all` toolbar (`OcrReviewPane.tsx:247-264`) stays unchanged — re-research is for verification failures (per-record), retry is for OCR failures (per-page). Different mechanisms.

**No new banner.** Inline failed-page cards plus the summary count are sufficient; banners stack and clutter the pane.

## Frontend types

`src/dashboard/components/ocr/types.ts` gains:

```ts
export interface FailedPage {
  page: number;
  error: string;
  attemptedKeys: string[];
  pageImagePath: string;
  attempts: number;
}

// PrepareRowData / OathPrepareRowData add:
//   failedPages?: FailedPage[];
//   pageStatusSummary?: { total: number; succeeded: number; failed: number };
```

`parsePrepareRowData` and `parseOathPrepareRowData` are extended to JSON-parse `data.failedPages` (it's stringified by `flattenForData` server-side, same as `records`).

## Edge cases

- **PNG missing:** retry returns 410; frontend toasts "Page image expired — reupload the PDF". Operator reuploads via the existing reupload path.
- **All pool keys exhausted:** page stays in `failedPages` with bumped `attempts`. Operator can retry later (rate limits clear over time), or use Re-OCR whole PDF as a fallback.
- **Approve with pages still failing:** allowed. The existing approve-batch (`/api/emergency-contact/approve-batch` and `/api/oath-signature/approve-batch`) already filters by `isApprovable`. Failed pages produce zero records, so they're naturally excluded from the fan-out.
- **Concurrent retries on the same row:** per-row mutex; second click returns 409 with toast "Retry already in progress for this row".
- **Reupload path:** unchanged. Reupload runs a fresh OCR; carry-forward (Levenshtein ≤ 2 by `carryForwardKey`) applies to surviving records. Failed pages from the previous run are not carried forward — the new run starts fresh per-page.
- **Row already approved/discarded:** retry returns 409. The row is no longer mutable.
- **eid-lookup timeout during retry:** matches today's orchestrator behavior. Failed lookup → record marked `unresolved`; operator uses the existing per-record Re-research button.

## Files touched

- `src/ocr/pipeline.ts` — drop the `<50% → whole-PDF` fallback; expose `pages[]` in result; export `runOcrWholePdf` helper for the manual button.
- `src/workflows/ocr/orchestrator.ts` — switch from `realOcrDocument` to `runOcrPipeline`; populate `failedPages` + `pageStatusSummary` in the `awaiting-approval` write; export `runOcrRetryPage` helper.
- `src/tracker/ocr-http.ts` — register `/api/ocr/retry-page` and `/api/ocr/reocr-whole-pdf` handlers; per-row mutex map.
- `src/dashboard/components/ocr/OcrReviewPane.tsx` — extend grouping to include failed pages; render `FailedPageCard` inline; add Re-OCR-whole-PDF header button + confirm dialog; update summary string.
- `src/dashboard/components/ocr/FailedPageCard.tsx` — new component.
- `src/dashboard/components/ocr/types.ts` — `FailedPage` interface; extend `parsePrepareRowData` / `parseOathPrepareRowData`.

## Testing

- **Unit:** `runOcrPipeline` test that fakes a pool with 3 pages where page 2 fails on every key; assert result has `pages[1].success === false`, `pages[1].attemptedKeys.length` matches retry budget, no whole-PDF fallback fired (use `__setProviderForTests` sentinel).
- **Unit:** `runOcrRetryPage` test that fakes the prior row state, runs retry on a single page, and asserts records are spliced (not appended) at the right `sourcePage` position.
- **Unit:** retry-page endpoint test for the per-row mutex — concurrent POSTs return 409 on the second.
- **Manual:** start dashboard, OCR a PDF, force a page failure (e.g. unset all but one provider key, then revoke that key mid-run), observe the failed-page card render with correct attempted-providers chips, click Retry, observe the card disappear and new records appear inline.
