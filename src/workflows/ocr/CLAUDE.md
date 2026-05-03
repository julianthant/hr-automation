# OCR Workflow — `src/workflows/ocr/`

The "prep phase" of any form-based workflow. Operator uploads a PDF → OCR
runs the per-form Zod-bound LLM extraction → roster match → eid-lookup +
verification → preview row in the OCR tab → operator approves/discards/
reuploads → on approve, fans out to the form-type's downstream daemon
(oath-signature or emergency-contact).

**Kernel-registered, NOT daemon-mode.** No browsers, no Duo. Runs in the
dashboard's Node process via fire-and-forget `runWorkflow` from
`/api/ocr/prepare`. Same shape as `sharepoint-download`.

## Files

- `workflow.ts` — `defineWorkflow(...)` + thin handler that calls the
  orchestrator. `systems: []`, `authSteps: false`.
- `orchestrator.ts` — `runOcrOrchestrator(input, opts)` — pure async
  function with test escape hatches. Replaces the duplicated
  `prepare.ts` runners that lived in `oath-signature/` and
  `emergency-contact/`.
- `form-registry.ts` — `FORM_SPECS = { oath, "emergency-contact" }`. One
  line to add a new form type once you've written its `ocr-form.ts`.
- `types.ts` — `OcrFormSpec<TOcr, TPreview, TFanOut>` contract.
- `carry-forward.ts` — `applyCarryForward({ v2, v1, spec })` — Levenshtein
  ≤ 2 fuzzy match by `spec.carryForwardKey`. Skips records flagged
  `forceResearch`.
- `schema.ts` — `OcrInputSchema` (Zod). Required fields:
  pdfPath, pdfOriginalName, formType, sessionId, rosterMode.
- `index.ts` — barrel.

## Adding a new form type

1. Create `src/workflows/<consumer>/ocr-form.ts` exporting an
   `OcrFormSpec` object. Mirror oath/EC for prompt + match + fan-out.
2. Add a record renderer component in `src/dashboard/components/ocr/`
   (e.g. `MyFormRecordView.tsx`).
3. Add the spec to `FORM_SPECS` in `form-registry.ts`.
4. Run modal's picker auto-populates from `GET /api/ocr/forms`.

## Lessons Learned

(empty — module is new as of 2026-05-01)
- **2026-05-03: `disambiguating` phase + `data.emptyPages` + manual-fill UX.** Orchestrator gained a new step name between `matching` and `eid-lookup` that batch-calls `disambiguateMatch` for any record left as `lookup-pending` with candidates ≥ 0.40 and `matchSource ∉ {form-eid, manual}`. Concurrency capped at `OCR_DISAMBIG_CONCURRENCY` (default 4). The awaiting-approval row carries `data.emptyPages: number[]` — pages where OCR succeeded but extracted zero records. Frontend `OcrReviewPane` interleaves these into `renderList` as a third entry kind (`empty`) and renders the page image on the left + `EmptyPagePlaceholder` on the right with "Add row manually" + "Mark as blank" actions. `PrepReviewMultiPair` gets an `[+ Add row to this page]` footer button for sign-in sheets where OCR extracted N-1 of N rows. New `OcrFormSpec.applyDisambiguation` hook lets each spec patch the record when the LLM returns; oath uses confidence ≥ 0.6 cutoff for auto-accept. Approval gate (`isApprovable`) now requires `/^\d{5,}$/` on `employeeId` when selected. Spec: `docs/superpowers/specs/2026-05-03-ocr-hybrid-match-and-manual-fill-design.md`.
