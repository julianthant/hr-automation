# Oath Upload Workflow

Files an HR General Inquiry ticket on `support.ucsd.edu` with the oath PDF
attached — AFTER every per-signer `oath-signature` row has finished and
succeeded.

**Fed by the OCR hub, not by uploading directly.** The operator's "full" oath
upload starts an **OCR prep** (`/api/ocr/prepare`, `lockedFormType: "oath"`).
On approve, OCR fans out one `oath-signature` signer row per approved record
AND one `oath-upload` ticket row (carrying the signer itemIds). The ticket row
waits on those signer rows, then files. This wait is **cross-daemon**
(oath-upload daemon waits on oath-signature daemon rows), so nothing blocks on
its own daemon's children — the fix for the prior single-worker deadlock.

**Kernel-based + daemon-mode**, `archetype: "single"`. The Oath Upload row is a
single row, grouped under the OCR run (`parentRunId`); the signer rows live in
the oath-signature tab.

## What this workflow does

Given an `OathUploadInput` (`pdfFileId` or `pdfPath`, `pdfOriginalName`,
`sessionId`, `signerItemIds`):

1. `wait-signatures` — `watchChildRuns({ workflow: "oath-signature", expectedItemIds: signerItemIds })`.
   Requires EVERY signer outcome `status === "done"`; if any is missing /
   `failed` / `cancelled`, THROW with a clear message and do NOT file the
   ticket ("verify everything is good before we upload"). Skipped when there
   are no `signerItemIds` (e.g. `upload-only`). The PDF path + hash are resolved
   from the file store via `pdfFileId` when not passed inline.
2. `servicenow-auth` — lazily launch the ServiceNow browser and authenticate.
   Deferred past the wait so the daemon does not hold a SAML session open
   across hours/days.
3. `open-hr-form` — navigate to the HR Inquiry form on `support.ucsd.edu`.
4. `fill-form` — subject `"HDH New Hire Oaths"`, description `"Please see
   attached oaths for employees hired under HDH."`, specifically
   `"Signing Ceremony (Oath)"`, category `"Payroll"`. Attach the PDF.
5. `submit` — capture the new ticket number from the redirect URL
   (`?id=ticket&number=HRC0XXXXXX`). Store on `data.ticketNumber`.

`upload-only` mode skips `wait-signatures` and files the ServiceNow ticket
directly (posts straight to `/api/oath-upload/start`, no OCR/signers).

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
wait is `watchChildRuns` over the signer itemIds (cross-daemon), not a
delegation.

## Retry safety

**Idempotent across retry.** Contract 2 makes retry a uniform kernel behavior:
a retry assigns a new runId and replays the handler from step 0 with the
pristine original input (`signerItemIds` included). `wait-signatures` re-watches
the same signer rows; if they already finished, the watch returns their
terminal outcomes immediately.

The ServiceNow-side duplicate probe
`findPriorTicketForSession(input.sessionId, input.pdfHash, trackerDir)` remains
the ticket-submission guard. It keys on stable business identity, not runId, so
a retry after a submitted ticket does not file a duplicate HR inquiry.

## Lessons Learned

- **Lesson maintenance rule:** Search this section and `src/workflows/oath-signature/CLAUDE.md` before adding oath-upload lessons. Keep the local model aligned with `docs/engineering/workflow-vocabulary.md`.
- **2026-06-02: OCR hub fan-out — oath-upload WAITS on signer rows, it no longer delegates.** The old handler ran `delegate-signatures` → `ctx.delegateTo(oathSignatureWorkflow, { pdfPath, ... })`, whose PDF handler ran OCR then `delegateToAll(self)` — deadlocking the single-worker oath-signature daemon (it held its only worker awaiting children queued on itself). New design: OCR is the hub. Its approve route fans out signer rows (one per record) AND one oath-upload ticket row (`approveDocumentTo`), each on its OWN daemon. oath-upload's `wait-signatures` step `watchChildRuns({ workflow: "oath-signature", expectedItemIds: input.signerItemIds })` and THROWS without filing if any signer is missing/failed/cancelled. Cross-daemon wait → no deadlock. `watchChildRuns` (itemId-based, SQLite+JSONL, cross-process) is the same primitive the OCR orchestrator uses; the handler calls it directly via the `_watchChildRunsOverride` test seam. Schema: `pdfPath`/`pdfHash` now optional (fan-out rows arrive with only `pdfFileId`; the handler resolves path+hash from the file store), `signerItemIds` added. Removed the `delegate-signatures` step + the `oathSignatureWorkflow` import entirely.
- **2026-06-02: The oath PDF entry is the OCR prep, not a direct oath-upload run.** The oath-upload run modal's "full" mode posts to `/api/ocr/prepare` (`lockedFormType: "oath"`); oath-upload rows are born only from the OCR approve fan-out. `upload-only` mode still posts to `/api/oath-upload/start` (files a ticket without OCR/signers). The roster picker is still required for full mode because the OCR prep needs a roster to match names → EIDs.
- **2026-05-24: Oath Upload is a single row, grouped under the OCR run.** The ticket row carries `parentRunId` (the OCR run) so it nests under the OCR card alongside the signer batch; signer rows live in the oath-signature tab.
- **2026-06-02: The oath operation brands `ou`; the oath-upload ticket row SHARES the OCR root's `ou-…` PREFIX with its own tail (root trace-id propagation, trace/span model).** The whole oath operation is branded `ou` via the OCR form spec's `traceCode` (the operator uploads "to Oath Upload", so the trace id names the destination, not OCR's own `oc`). approve.ts reads the OCR root row's frozen `ou-…` id and stamps its PREFIX (`tracePrefix(...)` = `ou-<HHMMSS>`) as `rootTracePrefix` on the oath-upload ticket's `__runtimeOptions`; the daemon worker then COMPOSES `<prefix>-<ownRunId4>` on the ticket row — sharing the operation prefix while keeping its own greppable tail/runId/itemId (logs/SQLite/footer `#run` unchanged). The dashboard batch header now shows the operation prefix (`ou-090553`) instead of `batch#<run4>`. DISPLAY-only — oath-upload still WAITS on the signer rows as before (siblings, not delegation). Mechanism in `src/core/CLAUDE.md` ("Root trace-id propagation") + `src/workflows/ocr/CLAUDE.md`. Pinned by `ocr-approve-oath-fanout.test.ts` + `tests/scenarios/delegate-to/oath-upload-shape.test.ts`.
- **Use `data.uploadMode`, not `data.mode`.** Dashboard read sites should dispatch on `resolveRowArchetype` / stamped `data.archetype`, not legacy task-role fields.
