# Oath Signature Workflow

Adds an **Oath Signature Date** row to UCPath Person Profile. Public starts are dashboard input runs for signer EIDs and upload runs for paper roster PDFs.

## Input Shape

Schema is `z.union([SignerSchema, PdfSchema])`, told apart by **field presence**
via the `isOathPdfInput` guard (`"pdfPath" in input`) — no `kind` discriminator,
same pattern as person-lookup. The two shapes have disjoint required fields so
presence is unambiguous.

- `{ emplId, name?, date?, dryRun? }` — signer variant: one EID, one UCPath transaction.
- `{ pdfPath, pdfOriginalName, sessionId, rosterMode?, rosterPath?, dryRun? }` — pdf variant: delegates to OCR, waits for approval, then fans out signer (EID) children via `ctx.delegateToAll`. Children carry `emplId`, so the presence guard routes them to the signer branch.

`archetype` resolves to `single` for signer inputs and `batch` for PDF inputs;
`inputSubject` resolves to `eid` (→ person row) for signer inputs and `pdf`
(→ file row) for PDF inputs. Delegated PDF runs keep `batch` plus `parentRunId`; signer children from the PDF branch are stamped `batch-member` under the PDF parent, even when OCR approval leaves only one selected signer.

## UCPath Rules

- Person Profile uses `#ptifrmtgtframe` / `TargetContent`, not the Smart HR frame. Use `oathSignature.getPersonProfileFrame(page)`.
- Search by Empl ID; the profile is unique.
- Dupe protection is live-page only: if the "no oath signature date" sentinel is absent, skip add/save and mark `Skipped (Existing Oath)`.
- Clear the search textbox before every daemon item; Return-to-Search can retain the previous EID.
- Direct Person Profile navigation can reopen the prior detail page. Verify the search textbox and recover with Return-to-Search before continuing.
- The Add New Oath link has duplicate accessible names; prefer the stable PeopleSoft id selector and keep role fallback second.

## OCR / PDF Path

- Paper-roster prep is owned by the shared OCR workflow with `formType: "oath"`.
- `/api/ocr/approve-batch` does not enqueue oath-signature signer rows. It writes terminal OCR approval and wakes the PDF branch, which then reads approved records and fans out signer children.
- Oath OCR prep item ids use the `oath-prep-` prefix to avoid collisions with emergency-contact prep.
- OCR keeps unsigned rows in prep payloads but deselects them by default.
- Roster load and name matching live in `src/services/matching/`.
- Capture finalization routes to the same PDF enqueue helper as `/api/oath-signature/start`.

## Selector Intelligence

Run `npm run selector:search "<intent>"` before mapping UCPath selectors. Search `src/systems/ucpath/LESSONS.md` first; the selector catalog has an `oathSignature` group.

## Lessons Learned

- **Lesson maintenance rule:** Merge old OCR-prep notes into the current shared-OCR model; do not preserve obsolete grouped-upload behavior.
- **2026-05-27: Oath-upload starts oath-signature through delegation.** The PDF branch owns OCR, approval, and signer fan-out.
- **2026-05-28: PDF path is batch by person cardinality.** A PDF upload represents an approved signer set after OCR, so the parent row is `batch` and fan-out signer rows are `batch-member` children of the PDF run. Do not special-case N=1 approval into a flat `single` row.
- **2026-05-26: Oath approve-side fan-out retired.** `approveTo` is intentionally omitted for oath forms; emergency-contact still uses approve-route fan-out.
- **2026-05-25: Dashboard input/upload runs are the public starts.** Do not restore `npm run oath-signature`.
- **Multi-file upload is N independent PDF runs.** Do not reintroduce a grouped upload card.
- **Hybrid match constants live in `src/services/ocr/forms/oath.ts`.**
