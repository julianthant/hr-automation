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
