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
   `formType: "oath"` plus the operator-selected `rosterMode` / `rosterPath`. The OCR row carries
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
| `archetype`   | `"delegating-batch"` — stamps `data.archetype: "batch-parent"` on the root row |
| `batch`       | `{ mode: "sequential", preEmitPending: true, betweenItems: ["reset"] }` |
| `tiling`      | `"single"`                                                                     |
| `authChain`   | `"sequential"`                                                                 |
| `detailFields`| PDF / OCR session / Signers / HR ticket # / Filed / Status. `data.uploadMode` carries the run mode (`"full"` / `"upload-only"`) — distinct from the legacy `data.mode` field which was renamed in the archetype migration (2026-05-17). |

### Row archetypes emitted

| Row                            | Archetype         | Dashboard surface          |
|--------------------------------|-------------------|----------------------------|
| Oath-upload daemon item (root) | `batch-parent`    | Queue card (top-level)     |
| OCR delegated child            | `delegate-child`  | Nested under parent's card |
| Per-signer oath-signature      | `delegate-child`  | Nested under parent's card |
| ServiceNow ticket              | (same root row, terminal status — no new row) |

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

## Retry safety

**Known idempotency gap (workflow bug — not a kernel concern).** Contract 2 makes retry a uniform kernel behavior: a retry assigns a NEW runId and replays the handler from step 0 with the pristine original input. The existing **Restart recovery** above keys ticket-skip on `data.ticketNumber` written by the prior run on the same runId — but a retry uses a new runId, so a `findPriorTicketForRunId(ctx.runId)` style probe would miss and the handler would file a SECOND HR ServiceNow ticket.

The fix lives in this workflow, not the kernel: probe by `sessionId` (`pdfHash` / `ocrSessionId`) — which IS preserved across retry because it comes from the original input — instead of `runId`. Scan all tracker entries for the workflow whose `data.pdfHash` matches, look for any prior entry with `data.ticketNumber`, and skip ServiceNow submission if found.

The dashboard duplicate-check banner already surfaces prior runs for the same hash on file select — operators retrying oath-upload are responsible for noting any prior `ticketNumber` in the banner before clicking Retry. The kernel does not gate this — no `supportsRetry` flag, no "not retryable" error; idempotency belongs in the workflow.

## Lessons Learned

- **Lesson maintenance rule:** Search this section and `src/workflows/ocr/CLAUDE.md` before adding oath-upload delegation lessons. Merge old restart/OCR notes into the current shared helper and runtime-shape rules.
- **OCR-delegating workflows need the roster picker.** Any Run modal for a workflow that depends on OCR roster matching must expose the same roster controls as the OCR modal. Never hardcode `rosterMode` at the delegation site; thread `rosterMode` and `rosterPath` into the delegated OCR run.
- **Use `data.uploadMode`, not `data.mode`.** Oath-upload root rows are `archetype: "delegating-batch"`; `data.mode` was renamed to avoid colliding with prep-row `data.mode === "prepare"` compatibility. Dashboard read sites should dispatch on `resolveRowArchetype` / stamped `data.archetype`, not legacy task-role fields.
- **Restart recovery uses tracker helpers.** Prior OCR approval lookup should use `findLatestEntryForPredicate` so newest-first scanning and malformed-line tolerance stay shared. Do not reintroduce workflow-local `existsSync` / `readFileSync` JSONL loops.
