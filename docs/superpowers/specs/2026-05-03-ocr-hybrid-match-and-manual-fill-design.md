# OCR Hybrid Match + Manual-Fill Surface — Design

**Date:** 2026-05-03
**Status:** Spec — pending implementation plan
**Workflows touched:** `ocr` (orchestrator), `oath-signature` (form spec), and the dashboard's OCR review pane.

## Problem

Today's OCR-pass flow is brittle in two ways that compounded into a user-visible "0 results" failure:

1. **Records are dropped on any LLM-omitted required field.** `OathRosterOcrRecordSchema` declares `rowIndex: z.number().int().nonnegative()` as required. The vision providers (Gemini / Mistral / Groq / Sambanova) are prompted to include `rowIndex` but receive no machine-enforced response shape, so they occasionally omit it — especially on single-record pages (UPAY585/586) where "row index 0" feels redundant. When that happens, `runOcrPerPage`'s `safeParse` (`per-page.ts:185-193`) drops the record with a one-line warn. One dropped record on a one-page PDF cascades to: 0 records → 0 to match → 0 to look up → 0 to verify → operator approval pane shows nothing.

2. **Roster matching is name-only and uses one threshold.** `oathOcrFormSpec.matchRecord` (`ocr-form.ts:152-196`) auto-accepts at score ≥ 0.85 (`ROSTER_AUTO_ACCEPT`). The 0.85–0.95 band is exactly where fuzzy is most often wrong (handwriting OCR errors, nicknames, middle-name variants), and there's no second-pass disambiguation — the algorithmic top is just trusted. The repo already ships a hybrid `matchAgainstRosterAsync` (`src/match/match.ts:301-341`) that wraps an LLM disambiguator (`src/ocr/disambiguate.ts`), but oath never calls it.

Result the operator sees: pages where OCR ran cleanly but a record was dropped show as "Done" with zero records and no preview pane content, leaving no manual-recovery path. They want consistent extraction AND a manual-fill surface for the LLM-incomplete cases.

## What already exists (do not rebuild)

- `matchAgainstRosterAsync(query, roster, opts)` — hybrid algorithmic + LLM match with `acceptThreshold` (default 0.85), `disambiguateThreshold` (default 0.50), and an injectable `disambiguator`. Returns `{eid, confidence, source: "roster" | "llm", candidates}`.
- `disambiguateMatch({query, candidates}) → {eid, confidence}` — Gemini text-only call with built-in key rotation. Auto-failover across `GEMINI_API_KEY*`.
- `OathRecordView` — already has editable `<input>`s for `printedName`, `employeeId`, `dateSigned`, `employeeSigned`, `officerSigned`. The manual-fill UX exists at the field level.
- `PrepReviewPair` / `PrepReviewMultiPair` — already render the **entire PDF page** on the left half of the review pane; multi-record pages keep the page sticky as the operator scrolls through rows. Backed by `PdfPagePreview` against `/api/prep/pdf-page`.
- `FailedPageCard` — already renders the page image with a "Retry page" button when whole-page OCR fails.
- `OcrFormSpec` contract (`src/workflows/ocr/types.ts`) — generic per-form spec the orchestrator already uses; only emergency-contact and oath implement it.

## Design

### New name-resolution pipeline (replaces today's matching phase for oath)

```
OCR pass (per-page, multi-provider pool) ─► raw records (schema-tolerant; see §schema relaxation)
        │
        ├─► Form-EID short-circuit
        │       record.employeeId ∈ roster?  →  matchSource: "form-eid", auto-accept
        │       record.employeeId present, not in roster  →  enqueue eid-lookup-by-EID
        │
        └─► Name-resolution chain
              top score ≥ 0.95 AND no second within 0.10  →  matchSource: "roster", auto-accept
              top score in [0.40, 0.95) OR close second   →  matchAgainstRosterAsync (LLM disambiguator)
                  ├─► LLM eid ≠ null, confidence ≥ 0.6  →  matchSource: "llm-disambig", accept
                  ├─► LLM eid ≠ null, confidence < 0.6  →  matchSource: "llm-disambig", needs-review
                  └─► LLM eid = null                     →  fall through ↓
              top score < 0.40 / no candidates / LLM=null →  matchSource: "manual",
                                                             enqueue eid-lookup-by-name as backstop,
                                                             surface in preview for manual EID entry
```

### Schema relaxation (the bug fix that prevents record drops)

`OathRosterOcrRecordSchema` becomes:

| Field | Today | New |
|---|---|---|
| `printedName` | required `string().min(1)` | unchanged — anchor field, without a name we have nothing |
| `rowIndex` | required `number().int().nonnegative()` | optional; runner synthesizes from array position when missing |
| `employeeSigned` | required `boolean()` | optional, defaults to `true` (worst case operator deselects) |
| `officerSigned` | already nullable+optional | unchanged |
| `dateSigned` | already nullable+optional | unchanged |
| `documentType` | already has default | unchanged |
| `notes`, `originallyMissing` | already have defaults | unchanged |
| `sourcePage` | runner-injected | unchanged |
| **`employeeId` (NEW)** | n/a | optional `string()` — captures EID printed on UPAY585/586 forms |

Records that still fail Zod after these defaults (true garbage — string instead of object, etc.) are coerced into `documentType: "unknown"` instead of dropped, so they surface in the preview pane with the existing "REMOVE FROM PILE" treatment. Operator sees them, doesn't approve them.

The runner change in `per-page.ts` mirrors the existing `sourcePage` injection at line 183:

```ts
r.rawRecords.forEach((rec, idx) => {
  const withInjects =
    rec && typeof rec === "object"
      ? {
          rowIndex: idx,                     // default; LLM value (if any) wins via spread
          employeeSigned: true,              // default; LLM value wins via spread
          ...(rec as Record<string, unknown>),
          sourcePage: r.page,                // runner overrides LLM
        }
      : rec;
  // ... existing safeParse + records.push
});
```

### Orchestrator changes

- New step name `disambiguating` (added between `matching` and `eid-lookup`). Auto-prepended to the OCR workflow's step list. Dashboard pipeline shows it as a discrete phase.
- `OcrFormSpec.matchRecord` becomes `Promise<TPreview>` (async). Existing emergency-contact spec wraps its sync logic in `async`.
- `runOcrOrchestrator` calls `matchRecord` per record, then collects records whose `matchState === "lookup-pending"` AND have ≥ 1 candidate ≥ 0.40 into a disambiguation batch — Promise.all with concurrency = `OCR_DISAMBIG_CONCURRENCY` (env, default 4). Each disambiguation result merges back into the record via a new `OcrFormSpec.applyDisambiguation(record, result)` method.
- New `data.emptyPages: number[]` on the `awaiting-approval` row — list of page numbers where OCR succeeded but extracted zero records. Computed alongside the existing `failedPages` and `pageStatusSummary`.
- Form-EID short-circuit lives in oath's `matchRecord`: when `record.employeeId` is non-empty, look it up in the roster's EID index; if matched, return a record with `matchSource: "form-eid"` and skip name matching entirely. If unmatched, set `matchState: "lookup-pending"` and let the orchestrator's eid-lookup-by-EID branch handle verification (new branch — see below).

### EID-lookup dispatch (orchestrator)

Today's `eid-lookup` phase enqueues by name when `needsLookup(rec) === "name"` and by EID when `needsLookup(rec) === "verify"`. Add a new `LookupKind: "verify-only"` returned by `oathOcrFormSpec.needsLookup` when `record.employeeId` is non-empty but didn't match the roster. Orchestrator dispatches this through the same `eidLookupCrmWorkflow` channel as today's "verify" branch — the only difference is provenance (form-supplied vs. roster-supplied EID). The verification result patches the record the same way.

### Dashboard preview-pane changes

**Always-visible page image: already shipped.** `PrepReviewPair` and `PrepReviewMultiPair` already render the full page next to the form cards. No change to those components.

**Empty-page placeholder (NEW).** When OCR succeeds on a page but extracts zero records, the orchestrator adds the page number to `data.emptyPages`. `OcrReviewPane`'s `renderList` builder (`OcrReviewPane.tsx:161-181`) gets a third entry kind `"empty"` interleaved with `"records"` and `"failed"` in `sourcePage` order. Renders as `PrepReviewPair` with the page on the left (as today) and a new `EmptyPagePlaceholder` card on the right:

```
┌─────────────────────────────────────────┐
│  OCR found no records on this page.     │
│                                          │
│  Compare against the page on the left   │
│  to confirm. If it's a real form, add   │
│  a row manually.                         │
│                                          │
│  [+ Add row manually]   [Mark as blank] │
└─────────────────────────────────────────┘
```

Add-row synthesizes a blank `OathPreviewRecord` ({printedName: "", employeeId: "", matchState: "manual", selected: false, sourcePage: page, rowIndex: 0, employeeSigned: true, officerSigned: null, dateSigned: null, notes: [], documentType: "expected", originallyMissing: [], warnings: []}), appends it to `localEdits`, and re-renders. Operator types from the always-visible page into the new row.

Mark-as-blank flips a local flag so the placeholder doesn't show again on this session (no tracker mutation).

**Add-row affordance on multi-record pages (NEW).** Sign-in sheets can have ~30 rows; the LLM occasionally extracts only some. Operators eyeballing the page-image-on-left vs. card-stack-on-right need to be able to add missing rows. `PrepReviewMultiPair` gets a small footer button below the card stack: `[+ Add row to this page]`. Behavior is identical to the empty-page placeholder's add-row: synthesize a blank `OathPreviewRecord` with this page's `sourcePage` (and `rowIndex` = current count of records on this page in localEdits), append to `localEdits`. No equivalent for `PrepReviewPair` (single-record form pages can't have multiple records by definition; if the one record was dropped to zero, the empty-page placeholder is what the operator sees).

Records that fail Zod entirely (truly malformed payloads — see schema relaxation §) are silently omitted from the per-page records array but DO contribute to the page being added to `emptyPages` if every record on that page failed; the operator still gets the page-image-on-left + "Add row manually" surface for that page. Partial drops (some records parsed, some failed) on a page are silent — but the operator can use the new add-row footer button to recover the missing one(s).

**Match-source badge + "Why this match?" (NEW).** Extend `OathRecordView` (and EC's record view) with:
- A `matchSource` badge next to the existing `matchState` badge: one of `roster` (algorithmic), `llm` (LLM disambig), `form-eid` (extracted from form), `eid-lookup` (looked up async), or `manual` (operator typed). Color: green for high-confidence (`roster` ≥ 0.95, `form-eid`), amber for `llm`, gray for `manual` until verified.
- A collapsible `<details>` "Why this match?" block that reveals:
  - `roster`: top candidate score
  - `llm`: the candidate list shown to the LLM (name + EID + algorithmic score), which one was picked, the LLM's confidence
  - `form-eid`: the EID as extracted from the form, and which roster row matched (or "no roster match — verifying")
  - `manual`: blank with a one-line "type EID below" hint

Operator can audit every auto-decision without leaving the pane.

**Approval gate (tighten).** Today's `isApprovable` (`OcrReviewPane.tsx:465-474`):
- `matchState ∈ {matched, resolved}` AND
- `documentType !== "unknown"` AND
- `verification.state === "verified"`

Add: when `selected === true`, `employeeId` must be non-empty and pass `/^\d{5,}$/`. This blocks approving a record whose only "match" is operator-typed but-still-empty input. Approve button text already shows "Approve N" — N continues to count only approvable selected.

### Decisions and rationale

**Threshold tuning — auto-accept ≥ 0.95 + no close second; LLM disambig in [0.40, 0.95).** Today's 0.85 threshold trusts fuzzy in the band where fuzzy is most often wrong (one-character OCR error, nickname). LLM disambigs cost ~$0.0001 per call and run sub-second; the false-match cost (oath signature filed in someone else's UCPath profile) is much higher. Sub-0.40 isn't worth a call — no usable signal.

**Disambiguator stays text-only.** The OCR pass already extracted the printed name from the page image. If the handwriting is so unreadable that vision-disambiguation would help, the right fix is to re-OCR the page (existing `Retry page` button), not bolt vision into the disambiguator. Reusing the existing `disambiguateMatch` is zero new code.

**EID-on-the-form is a first-class match path.** UPAY585/UPAY586 forms have a printed/handwritten Employee ID field. The OCR prompt already asks for it (`ocr-form.ts:120`); we just never put it in the schema. Extracting it lets us short-circuit name matching entirely when the operator wrote a clean EID — structured data beats handwritten name.

**Manual fill goes through existing editable inputs — no new data-entry UI.** `OathRecordView`'s inputs already write to `localEdits`. The "manual" matchSource just means the orchestrator left the EID blank for the operator to type. Verification re-runs on edit (existing behavior).

**Empty-page placeholder uses the existing PrepReviewPair grid.** Reusing the layout means the page-image-on-left invariant is automatic — operator gets the same visual context as a normal record page.

**Schema relaxation prevents the original failure mode at the source.** Even if the LLM gets sloppier in the future or a new provider is added, the runner-injected defaults mean a record can no longer disappear on a single missing field. Anything truly malformed surfaces as `documentType: "unknown"` which the existing "REMOVE FROM PILE" UX already handles.

### Out of scope (deferred)

- **Provider-side structured outputs** (Gemini `responseSchema`, OpenAI `json_schema`). Bigger change, only fixes one provider at a time, JSON-Schema subset has edge cases. Schema relaxation + manual-fill surface addresses the user-visible problem with much less risk. Revisit if false-omission rate stays high after this lands.
- **Vision in the disambiguator.** Add only if false-disambig rate proves too high after this lands; keep the existing text-only call as the baseline.
- **Emergency-contact behavior changes beyond opting into the new generic primitive.** EC has no EID-on-form path and its name-only matching gets the same hybrid treatment for free, but no spec-side changes.
- **Page-image lightbox / zoom controls.** The 8.5×11 panel already shows the page at a readable size. Add zoom only if operators report eye strain.
- **Per-row crop in the page preview** (highlighting "you're editing this row, here's the row in the source"). Sign-in sheets can have ~30 rows per page; row-coordinate detection isn't reliable at OCR time. The page-location chip ("Page 3, Row 7 of 12 in pile") that already exists on each card is enough for the operator to count down to the right row.

## Files to change

| File | Change |
|---|---|
| `src/ocr/per-page.ts` | Inject default `rowIndex` (array position) and `employeeSigned: true` before `safeParse`; coerce truly-malformed records to `documentType: "unknown"` instead of dropping. |
| `src/workflows/oath-signature/ocr-form.ts` | Add `employeeId: z.string().optional()` to `OathRosterOcrRecordSchema`; relax `rowIndex` and `employeeSigned` to optional; switch `matchRecord` to async; call `matchAgainstRosterAsync`; implement form-EID short-circuit; widen `MatchStateSchema` and `matchSource` enum to include `"form-eid"` and `"manual"`. |
| `src/workflows/emergency-contact/ocr-form.ts` | Wrap existing sync `matchRecord` in `async` (no behavior change); opt into the disambiguation phase. |
| `src/workflows/ocr/types.ts` | `OcrFormSpec.matchRecord` returns `Promise<TPreview>`; new `OcrFormSpec.applyDisambiguation(record, result) → TPreview`; widen `LookupKind` to include `"verify-only"`. |
| `src/workflows/ocr/orchestrator.ts` | Add `disambiguating` step; collect+batch-call disambiguation; emit `data.emptyPages: number[]`; dispatch eid-lookup-by-EID for `verify-only` lookups via the same eid-lookup channel. |
| `src/workflows/ocr/workflow.ts` | Add `"disambiguating"` to the step tuple. |
| `src/dashboard/components/ocr/EmptyPagePlaceholder.tsx` | NEW component: placeholder card for empty pages with "Add row manually" + "Mark as blank" buttons. |
| `src/dashboard/components/ocr/PrepReviewMultiPair.tsx` | Add `[+ Add row to this page]` footer button below the card stack; takes an `onAddRow(page)` prop. |
| `src/dashboard/components/ocr/OcrReviewPane.tsx` | Extend `renderList` to interleave empty-page entries; render `EmptyPagePlaceholder` inside `PrepReviewPair`; thread `onAddRow` callback into `PrepReviewMultiPair` (synthesizes blank record into `localEdits`); tighten `isApprovable` to require non-empty EID when selected. |
| `src/dashboard/components/ocr/OathRecordView.tsx` | New `matchSource` badge + collapsible "Why this match?" section (candidate list, LLM confidence, etc.). |
| `src/dashboard/components/ocr/EcRecordView.tsx` | Same badge + section (less content — no form-EID branch). |
| `src/dashboard/components/ocr/types.ts` | Parser for `data.emptyPages` (`?? []` fallback for pre-feature rows); widen `matchState` and `matchSource` enums. |
| `src/workflows/ocr/CLAUDE.md` | Lessons entry for the hybrid match + empty-page placeholder. |
| `src/workflows/oath-signature/CLAUDE.md` | Note the new EID-on-form short-circuit and form-eid match source. |
| `CLAUDE.md` (root) | Update the OCR workflow's step list in the "Step Tracking Per Workflow" table to include `disambiguating`. |

## Tests

- `tests/unit/ocr/per-page.test.ts` — verify rowIndex synthesis, employeeSigned default, and that records with neither rowIndex nor printedName are still dropped (true garbage path).
- `tests/unit/workflows/oath-signature/ocr-form.test.ts` — coverage for: form-EID short-circuit (matched + unmatched), name-only auto-accept (≥ 0.95 single, ≥ 0.95 with close second → LLM), name-only LLM-disambig (high confidence accept, low confidence needs-review, null fall-through), no-candidates fall-through.
- `tests/unit/workflows/ocr/orchestrator.test.ts` — `data.emptyPages` correctness for: 1 record on page 1, 0 records on page 2 (page 2 lands in emptyPages); `verify-only` dispatch for unmatched form-EIDs.
- `tests/unit/match/match-async.test.ts` — already exists; no changes needed (we're a consumer, not a definer).

Frontend changes verified manually per `src/dashboard/CLAUDE.md` ("Frontend test harness deferred").

## Success criteria

- Re-running the user's failing PDF (`Xerox Scan_04282026111307.pdf`) produces ≥ 1 record in the preview pane regardless of whether the LLM included `rowIndex`.
- Pages where OCR extracts zero records render with the page image visible and an "Add row manually" button.
- Operator can resolve every record (manual, llm-disambig, form-eid, or roster auto) before approving.
- `Approve N` button reflects only records that pass the strict approvability gate (matched/resolved + verified + non-empty EID when selected).
- No regression in emergency-contact's prep flow (opts into the same generic primitive but EC's matching behavior is unchanged).
