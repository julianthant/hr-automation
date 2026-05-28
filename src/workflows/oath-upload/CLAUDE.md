# Oath Upload Workflow

Operator uploads a paper-oath PDF. The workflow delegates the PDF to
**oath-signature**, waits for that delegated batch to complete, then files an
HR General Inquiry ticket on `support.ucsd.edu` with the original PDF attached.

**Kernel-based + daemon-mode**, `archetype: "single"`. The Oath Upload row is a
single row in the oath-upload tab. Its delegated signature work lives in the
oath-signature tab.

## What this workflow does

Given an `OathUploadInput` (`pdfPath`, `pdfOriginalName`, `sessionId`, `pdfHash`):

1. `delegate-signatures` — call
   `ctx.delegateTo(oathSignatureWorkflow, { kind: "pdf", ... }, { itemId: input.sessionId })`.
   The delegated oath-signature PDF run owns OCR, operator approval, and
   signer fan-out. The pinned `itemId` keeps restart/retry identity stable via
   the kernel's `tasks.original_input_json` contract.
2. `servicenow-auth` — lazily launch the ServiceNow browser and authenticate.
   Authentication stays after the long delegated wait so the daemon does not
   hold an authenticated session open across hours/days.
3. `open-hr-form` — navigate to the HR Inquiry form on `support.ucsd.edu`.
4. `fill-form` — subject `"HDH New Hire Oaths"`, description `"Please see
   attached oaths for employees hired under HDH."`, specifically
   `"Signing Ceremony (Oath)"`, category `"Payroll"`. Attach the original PDF.
5. `submit` — capture the new ticket number from the redirect URL
   (`?id=ticket&number=HRC0XXXXXX`). Store on `data.ticketNumber`.

`upload-only` mode skips `delegate-signatures` and files the ServiceNow ticket
directly.

## Selector Intelligence

This workflow touches: **servicenow**.

Before mapping a new selector, run `npm run selector:search "<intent>"`.

- [`src/systems/servicenow/LESSONS.md`](../../systems/servicenow/LESSONS.md)
- [`src/systems/servicenow/SELECTORS.md`](../../systems/servicenow/SELECTORS.md)
- [`src/systems/servicenow/common-intents.txt`](../../systems/servicenow/common-intents.txt)

## Dupe-protection

The dashboard's Run modal calls `/api/oath-upload/check-duplicate?hash=<sha256>`
on file select. If prior runs exist for that hash, a banner shows
date + terminal step + ticket number. **Non-blocking** — operator can
upload again. Hash is stored on every tracker line via `data.pdfHash`. See
`duplicate-check.ts`.

Before submitting the HR form, the handler also probes prior oath-upload rows
by stable business identity (`sessionId`, with defensive `pdfHash` matching)
via `findPriorTicketForSession`. If a prior filed ticket number exists, the
handler stamps that ticket and skips the ServiceNow submit steps.

## Soft-cancel

Oath-upload cancellation uses the standard workflow-control path. The long
wait is now inside kernel delegation to oath-signature rather than a local OCR
or child-run polling helper.

## Retry safety

**Idempotent across retry.** Contract 2 makes retry a uniform kernel behavior:
a retry assigns a new runId and replays the handler from step 0 with the
pristine original input. The delegated oath-signature PDF run is pinned to
`itemId: input.sessionId`, and the kernel stores pristine child input in
`tasks.original_input_json`.

The ServiceNow-side duplicate probe
`findPriorTicketForSession(input.sessionId, input.pdfHash, trackerDir)` remains
the ticket-submission guard. It keys on stable business identity, not runId, so
a retry after a submitted ticket does not file a duplicate HR inquiry.

## Lessons Learned

- **Lesson maintenance rule:** Search this section and `src/workflows/oath-signature/CLAUDE.md` before adding oath-upload delegation lessons. Keep the local model aligned with `docs/engineering/workflow-vocabulary.md`.
- **2026-05-27: Oath Upload delegates to oath-signature, not OCR/signature internals.** Full-mode uploads delegate one `{ kind: "pdf" }` child to oath-signature and wait for that delegated batch-stage row to finish. Oath-signature owns its normal PDF branch after that: OCR preview, EID lookup/verification, approval, and signer fan-out. The parented PDF row keeps `archetype: "batch"` plus `parentRunId`; delegated scope is not a separate row archetype.
- **2026-05-26: Oath Upload collapsed onto kernel delegation.** Plan A Commit 4 removed the local OCR prepare call, `waitForOcrApproval`, and `watchChildRuns` polling from the handler. Full-mode uploads now run one `delegate-signatures` step that delegates `{ kind: "pdf", ... }` to oath-signature with `itemId: input.sessionId`; oath-signature owns OCR approval and signer fan-out. Oath-upload only resumes to file ServiceNow after the delegated run is terminal.
- **2026-05-24: Oath Upload is a single row.** The row stays flat in the oath-upload tab. Delegated signature work appears in oath-signature's tab; do not nest children under the oath-upload row.
- **OCR-delegating workflows need the roster picker.** Any Run modal for a workflow that depends on OCR roster matching must expose the same roster controls as the OCR modal. Never hardcode `rosterMode` at the dispatch site; thread `rosterMode` and `rosterPath` into the delegated PDF input.
- **Use `data.uploadMode`, not `data.mode`.** Dashboard read sites should dispatch on `resolveRowArchetype` / stamped `data.archetype`, not legacy task-role fields.
