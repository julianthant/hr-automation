# Oath Upload Workflow

Operator uploads a paper-oath PDF; the workflow OCRs it, fans out N
oath-signature daemon items (one per signer), waits for every UCPath
transaction to complete, and then files an HR General Inquiry ticket
on `support.ucsd.edu` with the original PDF attached. One operator
action; one ticket.

**Kernel-based + daemon-mode.** Same shape as `oath-signature` /
`separations`, but with `systems: [servicenow]` and a handler that
delegates to OCR + the oath-signature daemon mid-flight.

## What this workflow does

Given an `OathUploadInput` (`pdfPath`, `pdfOriginalName`, `sessionId`,
`pdfHash`):

1. Authenticate `servicenow` (UCSD SSO + Duo) once per daemon spawn.
2. Delegate OCR (`runWorkflow(ocrWorkflow, …, parentRunId: ctx.runId)`).
   `formType: "oath"`, `rosterMode: "download"`. The OCR row carries
   `parentRunId` so the dashboard nests it under this row.
3. Wait for the OCR row to reach `step="approved"` (operator clicks
   approve on the OCR row's existing UI). Custom `isTerminal` predicate
   on `watchChildRuns`. 7-day backstop. On `step="discarded"`, fail.
4. Read the OCR approve entry's `data.fannedOutItemIds` (written by the
   OCR approve handler) — these are the oath-signature itemIds.
5. Wait for every fanned-out oath-signature item to reach `status="done"`.
   Failed children pause the parent indefinitely; operator retries them
   from the oath-signature tab and the parent auto-resumes when the
   watch sees all-done.
6. Navigate to the HR Inquiry form on `support.ucsd.edu`.
7. Fill subject `"HDH New Hire Oaths"`, description `"Please see
   attached oaths for employees hired under HDH."`, specifically
   `"Signing Ceremony (Oath)"`, category `"Payroll"`. Attach the
   original PDF.
8. Submit. Capture the new ticket number from the redirect URL
   (`?id=ticket&number=HRC0XXXXXX`). Store on `data.ticketNumber`.

## Selector Intelligence

This workflow touches: **servicenow**.

Before mapping a new selector, run `npm run selector:search "<intent>"`.

- [`src/systems/servicenow/LESSONS.md`](../../systems/servicenow/LESSONS.md)
- [`src/systems/servicenow/SELECTORS.md`](../../systems/servicenow/SELECTORS.md)
- [`src/systems/servicenow/common-intents.txt`](../../systems/servicenow/common-intents.txt)

## Files

- `schema.ts` — `OathUploadInputSchema` (pdfPath, pdfOriginalName, sessionId, pdfHash)
- `handler.ts` — linear handler body + step list
- `wait-ocr-approval.ts` — wraps `watchChildRuns` for OCR's approve/discard predicate
- `fill-form.ts` — Playwright form-fill + submit + ticket-number parser
- `duplicate-check.ts` — SHA-256 + prior-run scanner for the dashboard pre-flight
- `workflow.ts` — `defineWorkflow` + `runOathUpload` + `runOathUploadCli`
- `index.ts` — barrel

## Kernel Config

| Field         | Value                                                                          |
| ------------- | ------------------------------------------------------------------------------ |
| `systems`     | `[{ id: "servicenow", login: loginToServiceNow }]`                             |
| `authSteps`   | `false` (we declare `servicenow-auth` ourselves)                               |
| `steps`       | `["servicenow-auth", "delegate-ocr", "wait-ocr-approval", "delegate-signatures", "wait-signatures", "open-hr-form", "fill-form", "submit"]` |
| `schema`      | `{ pdfPath, pdfOriginalName, sessionId, pdfHash }`                             |
| `batch`       | `{ mode: "sequential", preEmitPending: true, betweenItems: ["reset-browsers"] }` |
| `tiling`      | `"single"`                                                                     |
| `authChain`   | `"sequential"`                                                                 |
| `detailFields`| PDF / OCR session / Signers / HR ticket # / Filed / Status                     |

## Dupe-protection

The dashboard's Run modal calls `/api/oath-upload/check-duplicate?hash=<sha256>`
on file select. If prior runs exist for that hash, a banner shows
date + terminal step + ticket number. **Non-blocking** — operator can
upload again. Hash is stored on every tracker line via
`data.pdfHash`. See `duplicate-check.ts`.

## Restart recovery

The handler's first action probes the OCR JSONL for any prior entry
with the same `ocrSessionId`. If a prior run reached
`step="approved"`, `delegate-ocr` and `wait-ocr-approval` are
skipped — `fannedOutItemIds` is read from the prior approved entry
and the handler jumps straight to `wait-signatures`. This makes the
handler idempotent on daemon restart (kernel re-claims the queue
item with the same runId via the existing `recoverOrphanedClaims`
flow, the handler re-enters from step 1, and the probe avoids
re-firing OCR).

## Soft-cancel

`POST /api/oath-upload/cancel` writes a `running` tracker entry on
the oath-upload row with `step="cancel-requested"`. Both
`watchChildRuns` calls have an `abortIfRowState` opt that polls the
parent's own row and rejects if the sentinel appears — so the daemon
can be in any of the two long waits and still cancel cleanly. After
the abort, the kernel's failure path emits `failed` step
`"cancelled"`.

## Lessons Learned

(empty — module is new as of 2026-05-01)
