# Oath Upload Workflow

Files an HR General Inquiry ticket on `support.ucsd.edu` with the oath PDF
attached — AFTER every per-signer `oath-signature` row has finished and
succeeded.

**Full mode is born at upload.** The operator's "full" oath upload starts the
real `oath-upload` ticket row at `/api/ocr/prepare`, then delegates an OCR prep
under it (`lockedFormType: "oath"`). On approve, OCR fans out one
`oath-signature` signer row per approvable record; the existing ticket row
learns those signer itemIds via `wait-approval`, waits on them, then files. This
wait is **cross-daemon** (oath-upload daemon waits on oath-signature daemon
rows), so nothing blocks on its own daemon's children — the fix for the prior
single-worker deadlock.

**Kernel-based + daemon-mode**, `archetype: "single"`. In full mode the Oath
Upload row is the top-level ticket row; the OCR prep is delegated under it. The
signer rows live in the oath-signature tab.

## What this workflow does

Given an `OathUploadInput` (`pdfFileId` or `pdfPath`, `pdfOriginalName`,
`sessionId`, optional `signerItemIds`):

1. `wait-approval` — full born-at-upload rows with no `signerItemIds` call
   `subscribeToApproval({ workflow: "ocr", sessionId })` and learn the signer
   itemIds from the approved OCR row's `fannedOutItemIds`. If approval produces
   zero signer rows, THROW and do NOT file the ticket.
2. `wait-signatures` — `watchChildRuns({ workflow: "oath-signature", expectedItemIds: signerItemIds })`.
   Requires EVERY signer outcome `status === "done"`; if any is missing /
   `failed` / `cancelled`, THROW with a clear message and do NOT file the
   ticket ("verify everything is good before we upload"). Skipped only for
   `upload-only`. The PDF path + hash are resolved from the file store via
   `pdfFileId` when not passed inline.
3. `servicenow-auth` — lazily launch the ServiceNow browser and authenticate.
   Deferred past the wait so the daemon does not hold a SAML session open
   across hours/days.
4. `open-hr-form` — navigate to the HR Inquiry form on `support.ucsd.edu`.
5. `fill-form` — subject `"HDH New Hire Oaths"`, description `"Please see
   attached oaths for employees hired under HDH."`, specifically
   `"Signing Ceremony (Oath)"`, category `"Payroll"`. Attach the PDF.
6. `submit` — capture the new ticket number from the redirect URL
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

**Cancel is TREE-scoped** (E2E-010, 2026-06-12): the runtime policy overrides
the default row-scope cancel because a full-mode ticket owns a delegated OCR
prep (`parentRunId` = the ticket run). The row × therefore cancels the ticket
AND walks its descendants (the OCR review, its lookups) via
`resolveActionTargets`' tree walk — a row-scoped cancel left the review
orphaned at awaiting-approval for a cancelled parent. Pinned by
`tests/unit/workflows/runtime-policies.test.ts` +
`tests/unit/domain/workflow-runtime-projection.test.ts` (tree scope).

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
- **2026-06-22: Re-uploading the same PDF to full-mode oath-upload is refused UP FRONT with a structured duplicate, not a silent success (ISS-001).** The handler's idempotency probe (`findPriorTicketForSession`) keys on `sessionId`, which is minted fresh per upload — so it only catches Contract-2 *retries* of the SAME session, never a content re-upload in a new session. A duplicate full-mode upload therefore slipped through `/api/ocr/prepare` (the modal's `duplicateCheck` banner is advisory-only and was keyed on `data.pdfHash`), returned a bare 202, closed the modal as success, and could file a SECOND ServiceNow ticket. Fix: `buildOcrPrepareHandler` now probes for a prior FILED oath-upload ticket by PDF CONTENT (the new `findPriorOathUploadTicket` seam — default resolves the full sha256 from `pdfFileId` via the registered-file store, then `findPriorRunsForHash` filtered to `HRC…` tickets) BEFORE the session lock / born-task enqueue. On a hit it returns `409 { ok:false, duplicate:true, priorTicket, error }` — the RunModal surfaces `error` and keeps the modal open (no second ticket enqueued). The durable filed row already carries `pdfHash` (the handler derives it from `pdfFileId` and `ctx.updateData`s it), so the content index finds it. Probe is fail-safe: any miss (no fileId / unregistered / no filed ticket) lets the upload proceed. Pinned by `tests/unit/tracker/dashboard/ocr-operation-tracking.test.ts` ("…returns a structured duplicate (not silent 202) … (ISS-001)").
- **2026-06-12: The born-at-upload pre-emit is a standard `pending` row, and the input schema has NO roster fields (E2E-006/E2E-008).** Two e2e fixes that change this workflow's contracts: (1) `defaultEnqueueOathUploadAtPrepare` pre-emits the born ticket as `status:"pending"` with no step — stamping `running`/`ocr-prep` made queued runs lie ("Running / Ocr Prep…") while the rail said queued, and the row × forwarded the stale running status into a 409 (the daemon's claim emits the real running rows; `cancelTarget` additionally falls back across queued/running on a `code: "wrong-state"` 409 so presentation lag can never strand a cancel — pinned by `tests/unit/control/perform-workflow-action.test.ts`). (2) `rosterMode`/`rosterPath` were REMOVED from `OathUploadInputSchema`, `/api/oath-upload/start`, and the born-task input — the handler never read them (OCR owns roster matching), yet the born input hardcoded `rosterMode:"download"`, silently contradicting the operator's modal choice; old persisted inputs still parse (Zod strips unknown keys). The born ticket also returns its trace id so the delegated OCR prep COMPOSES the ticket's `ou-<HHMMSS>` prefix (`rootTracePrefix` orchestrator opt, VQ-1) instead of minting its own start-second.
- **2026-06-08: Full born-at-upload approval with ZERO signer rows must fail loud, not file an empty ticket.** `wait-approval` can return an approved OCR payload whose `fannedOutItemIds` is empty when every selected record was skipped by `approveTo.canFanOut` (for oath, no resolved EID). That is not equivalent to `upload-only`: full mode means "verify everything is good before we upload." The handler now checks `needsApprovalWait && signerItemIds.length === 0` immediately after approval, stamps `status:"approval-empty"` / `signerCount:"0"`, and throws `NOT filing` before `wait-signatures` or ServiceNow. `upload-only` remains the only path that legitimately skips signer waits.
- **2026-06-03: Full-mode oath-upload is born at upload (option A) and walks `wait-approval → wait-signatures → … → submit` as ONE row.** Instead of being created at OCR approval by `approveDocumentTo`, a full oath-upload run is enqueued at `/api/ocr/prepare` (`targetWorkflow="oath-upload"`, `defaultEnqueueOathUploadAtPrepare`) as a real `single` daemon task; the OCR run is delegated **under it** (`parentRunId = oathUploadRunId`). The handler gained a leading **`wait-approval`** step (step list is now `["wait-approval","wait-signatures","servicenow-auth","open-hr-form","fill-form","submit"]`): when a `full` row arrives WITHOUT `signerItemIds`, it `subscribeToApproval({ workflow:"ocr", sessionId })` (cross-process via the JSONL backstop) to learn its signer set from the approved OCR row's `fannedOutItemIds`, then proceeds to the unchanged `wait-signatures`. A discard rejects the wait with `OcrDiscardedError` → the handler throws, no ticket; a hard OCR prep failure rejects with `OcrApprovalFailedError` → the handler also throws, no ticket. If the born-at-upload task itself can't be created at prepare time (`defaultEnqueueOathUploadAtPrepare` returns `undefined` — oath-upload unloadable / pre-emit never fired), `/api/ocr/prepare` FAILS LOUD: it aborts the OCR run and emits a `failed step=ocr-prep-failed` oath-upload row instead of running OCR with no consumer (which would sign oaths but file no ServiceNow ticket); the operator re-uploads to retry. **Additive + back-compat:** the leading step is SKIPPED whenever `signerItemIds` is already present (legacy approve fan-out) or `mode==="upload-only"`, so the kept `oath-upload-smoke`/`oath-upload-extended` integration tests and the `ocr-oath-upload` delegation test (which seed no `operationWorkflow`) are untouched. The approve route skips the once-per-document ticket fan-out for `operationWorkflow==="oath-upload"` (the born-at-upload task IS the ticket — no second row). Pinned by `tests/unit/workflows/oath-upload/handler.test.ts` (born-at-upload + discard + hard OCR failure), `tests/unit/services/ocr/approval-signal.test.ts`, and `tests/unit/tracker/dashboard/ocr-operation-tracking.test.ts`.
- **2026-06-02: OCR hub fan-out — oath-upload WAITS on signer rows, it no longer delegates.** The old handler ran `delegate-signatures` → `ctx.delegateTo(oathSignatureWorkflow, { pdfPath, ... })`, whose PDF handler ran OCR then `delegateToAll(self)` — deadlocking the single-worker oath-signature daemon (it held its only worker awaiting children queued on itself). OCR remains the prep/approval hub. In the current 2026-06-03 model, full-mode oath-upload is born at upload and the approve route fans out only signer rows for that operation; standalone OCR oath runs still use the legacy once-per-document `approveDocumentTo` ticket fan-out. `wait-signatures` still calls `watchChildRuns({ workflow: "oath-signature", expectedItemIds: signerItemIds })` and THROWS without filing if any signer is missing/failed/cancelled.
- **2026-06-02 historical note, superseded 2026-06-03:** The oath PDF entry used to be only the OCR prep, with oath-upload rows born from OCR approve fan-out. Current full-mode oath-upload rows are born at `/api/ocr/prepare` as the real single ticket workflow; `upload-only` mode still posts to `/api/oath-upload/start` (files a ticket without OCR/signers).
- **2026-05-24 historical note, superseded 2026-06-03:** Oath Upload ticket rows used to be grouped under the OCR run. Current full-mode oath-upload is the top-level single row and OCR is delegated under it; signer rows live in the oath-signature tab.
- **2026-06-02 (rev. 2026-06-12): The oath-UPLOAD operation brands `ou`, and the whole tree shares one prefix (root trace-id propagation, trace/span model).** In the born-at-upload model the TICKET mints the root `ou-<HHMMSS>-<run4>` id (the `ou` code comes from `operationTraceCode("oath-upload")` / the workflow's own `code` — the oath FORM SPEC no longer declares a `traceCode`; standalone OCR-panel oath uploads brand `oc-…`, see E2E-007 in `src/workflows/ocr/CLAUDE.md`). The delegated OCR prep COMPOSES the ticket's prefix via the orchestrator's `rootTracePrefix` opt (VQ-1 — it previously minted its own start-second, drifting +2s off the ticket), and the approve fan-out's signer rows compose the same prefix via `__runtimeOptions.rootTracePrefix`. Every row of one operation reads `ou-<HHMMSS>-<itsOwnRunId4>` — one greppable operation, each row individually addressable. DISPLAY-only — oath-upload still WAITS on the signer rows as before (siblings, not delegation). Mechanism in `src/core/CLAUDE.md` ("Root trace-id propagation"). Pinned by `ocr-approve-oath-fanout.test.ts` + `orchestrator.test.ts` (rootTracePrefix compose).
- **Use `data.uploadMode`, not `data.mode`.** Dashboard read sites should dispatch on `resolveRowArchetype` / stamped `data.archetype`, not legacy task-role fields.
