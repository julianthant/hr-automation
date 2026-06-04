# Oath Signature Workflow

Adds an **Oath Signature Date** row to UCPath Person Profile. **EID-only** — one
EID, one UCPath transaction, one row. Public starts are dashboard **input runs**
for signer EIDs. The paper-roster PDF flow lives elsewhere: OCR is the prep/
approval hub and fans out one signer row here per approved record (see "OCR /
PDF Path" below).

## Input Shape

Schema is the bare signer object (no `z.union` / `isOathPdfInput` — the PDF
variant was removed 2026-06-02):

- `{ emplId, name?, date?, dryRun?, parentSubject? }` — one EID, one UCPath transaction.

`archetype` is always `single` (one EID, one transaction); `inputSubject` is
always `eid` (→ person row). **But oath-signature always renders as a batch,
never a standalone single row** — its runtime policy sets both
`delegation.alwaysBatchDelegatedMembers` (a lone OCR-fan-out signer is a
one-member batch) and `delegation.alwaysBatchInputRun` (a single manual EID
input run is a one-member batch too; `enqueue-dispatch.ts` forces a batch
`parentRunId` even for one item). The per-row `archetype` stays `single`; the
*surface* is always a batch. `OathSignerInput` is an alias of
`OathSignatureInput`.

## UCPath Rules

- Person Profile uses `#ptifrmtgtframe` / `TargetContent`, not the Smart HR frame. Use `oathSignature.getPersonProfileFrame(page)`.
- Search by Empl ID; the profile is unique.
- Dupe protection is live-page only: if the "no oath signature date" sentinel is absent, skip add/save and mark `Skipped (Existing Oath)`.
- Clear the search textbox before every daemon item; Return-to-Search can retain the previous EID.
- Direct Person Profile navigation can reopen the prior detail page. Verify the search textbox and recover with Return-to-Search before continuing.
- The Add New Oath link has duplicate accessible names; prefer the stable PeopleSoft id selector and keep role fallback second.

## OCR / PDF Path

- A PDF run ("Run Oath Signature") creates an `operation` coordinator row in the Oath Signature panel at `/api/ocr/prepare` (`targetWorkflow="oath-signature"`); the OCR run is delegated under it and the approved signer rows parent to it as inline expandable member rows. An oath-signature PDF run files NO ServiceNow ticket. See `src/workflows/ocr/CLAUDE.md` (2026-06-03 operation-tracking lesson). Direct EID input runs are unchanged (no operation row).
- Paper-roster prep is owned by the shared OCR workflow with `formType: "oath"`.
- `/api/ocr/approve-batch` **fans out** oath-signature signer rows on approve via the oath form spec's `approveTo` (one signer row per approved record, EID-only). The once-per-document `oath-upload` ticket fan-out happens only for standalone OCR oath runs; an oath-signature PDF operation signs only and files no ServiceNow ticket.
- `buildOathSignerInputFromApprovedRecord` + `hasOathSignerInput` live in `src/services/ocr/forms/oath.ts` (used by the approve fan-out). `approveTo.canFanOut` skips a selected-but-EID-less record so the per-record itemIds stay in sync with the rows oath-upload waits on.
- Per-record fan-out item ids are `ocr-oath-<ocrRunId>-r<index>`.
- OCR keeps unsigned rows in prep payloads but deselects them by default.
- Roster load and name matching live in `src/services/matching/`.

## Selector Intelligence

Run `npm run selector:search "<intent>"` before mapping UCPath selectors. Search `src/systems/ucpath/LESSONS.md` first; the selector catalog has an `oathSignature` group.

## Lessons Learned

- **Lesson maintenance rule:** Merge old OCR-prep notes into the current shared-OCR model; do not preserve obsolete grouped-upload behavior.
- **2026-06-02: OCR hub fan-out — oath-signature is EID-only; the self-fan-out deadlock is gone.** The old PDF branch (`runPdfBranch`) ran OCR then `await ctx.delegateToAll(oathSignatureWorkflow, signers)` — fanning signer children onto the SAME single-worker oath-signature daemon it ran on. The daemon claim loop is strictly sequential (`state.activeRun` is singular: claim one → await to completion → claim next), so the parent held the only worker while awaiting and the queued signer child was never claimed → permanent stall (oath-signature frozen at `step=ocr`, signer `batch-member` stuck `queued`). Fix: OCR is now the prep/approval hub. On approve it fans out to TWO independent workflows on DIFFERENT daemons — one `oath-signature` EID signer row per approved record (`approveTo`) AND one `oath-upload` ticket row (`approveDocumentTo`) that WAITS for all the signer rows to finish (cross-daemon, via `watchChildRuns`) before filing. **Intent-routed since 2026-06-03:** the `approveDocumentTo` ticket fan-out is now gated by `data.operationWorkflow` — it fires only for a STANDALONE OCR oath run. An oath-signature *operation* run (PDF uploaded in the Oath Signature panel) signs only and files no ticket; an oath-upload operation run skips the new ticket because its born-at-upload task files it. `approveTo` signer fan-out is unconditional. See `src/workflows/ocr/CLAUDE.md` (2026-06-03 operation-tracking lesson). oath-signature dropped the union/`PdfSchema`/`isOathPdfInput`/`runPdfBranch`/`readApprovedSignerInputs` and the `ocr`+`delegate-signatures` steps; steps are now `["ucpath-auth","transaction"]`, archetype `single`, inputSubject `eid`. The `/api/oath-signature/start` PDF surface + `enqueueOathSignaturePdf` + its run-modal entry were retired; oath-signature stays in INPUT runs only. **Rule:** never `delegateToAll(self)` onto your own single-worker daemon while holding it — fan independent work onto a different daemon and wait cross-daemon.
- **2026-06-01: UCPath Duo is deferred to the `ucpath-auth` step, not session launch.** The kernel authenticates every declared `system` eagerly at launch, so a real `ucpath` `login` fired Duo immediately. Fix: `ucpath` `login` is a no-op, and `runSignerBranch` runs a real `loginToUCPath` inside a `ucpath-auth` step (mirrors oath-upload's ServiceNow deferral). A fan-out signer child Duos only after OCR approval, when it reaches UCPath. `loginToUCPath` is idempotent (`"already_logged_in"`), so a daemon Duos once on the first item and reuses the warm session for the rest (incl. across `betweenItems: ["reset"]`, which keeps cookies).
- **2026-05-25: Dashboard input runs are the public start.** oath-signature is an INPUT-run workflow (typed EIDs). Do not restore `npm run oath-signature` or a PDF upload-run entry.
- **Hybrid match constants live in `src/services/ocr/forms/oath.ts`** (along with `buildOathSignerInputFromApprovedRecord` / `hasOathSignerInput` / `normalizeOathDate`, used by the OCR approve fan-out).
