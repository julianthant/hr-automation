# Oath Upload Workflow

Operator uploads a paper-oath PDF. The workflow dispatches the OCR + per-signer
signature batch into the **oath-signature** tab (via the `originWorkflow`
mechanism on `/api/ocr/prepare`), waits for every UCPath signature to finish,
then files an HR General Inquiry ticket on `support.ucsd.edu` with the original
PDF attached.

**Kernel-based + daemon-mode**, `archetype: "single"`. The Oath Upload row is a
single flat card in the oath-upload tab — **no children nest under it**. OCR
and per-signer rows live under a synthesized `batch-parent` row in the
oath-signature tab.

## What this workflow does

Given an `OathUploadInput` (`pdfPath`, `pdfOriginalName`, `sessionId`, `pdfHash`):

1. `dispatch` step — call the OCR prepare handler with
   `originWorkflow: "oath-signature"`. This synthesizes a `batch-parent` row
   in the oath-signature tab (subtitle `Oath · <last4 run id>`), kicks off the
   OCR orchestrator with the synthesized row's `parentRunId`, and returns
   that runId. Wait for the OCR row (`workflow: "ocr"`, `id: ocrSessionId`)
   to reach `step="approved"`; read `fannedOutItemIds` off the approved
   entry. The signer fan-out happens HTTP-side in the OCR approve handler
   — children inherit the synthesized parent's `parentRunId` and nest
   under it in the oath-signature tab.
2. `wait-signatures` — poll the fanned-out oath-signature item ids until
   every one is `status="done"`. Failed children pause oath-upload
   indefinitely; operator retries them from the oath-signature tab and
   oath-upload auto-resumes when the watch sees all-done. 7-day backstop.
3. `servicenow-auth` — lazily launch the ServiceNow browser and
   authenticate. (Authentication is deferred until AFTER the long wait so
   we don't hold an authenticated session open across hours/days.)
4. `open-hr-form` — navigate to the HR Inquiry form on `support.ucsd.edu`.
5. `fill-form` — subject `"HDH New Hire Oaths"`, description `"Please see
   attached oaths for employees hired under HDH."`, specifically
   `"Signing Ceremony (Oath)"`, category `"Payroll"`. Attach the original PDF.
6. `submit` — capture the new ticket number from the redirect URL
   (`?id=ticket&number=HRC0XXXXXX`). Store on `data.ticketNumber`.

## Selector Intelligence

This workflow touches: **servicenow**.

Before mapping a new selector, run `npm run selector:search "<intent>"`.

- [`src/systems/servicenow/LESSONS.md`](../../systems/servicenow/LESSONS.md)
- [`src/systems/servicenow/SELECTORS.md`](../../systems/servicenow/SELECTORS.md)
- [`src/systems/servicenow/common-intents.txt`](../../systems/servicenow/common-intents.txt)

## Files

- `schema.ts` — `OathUploadInputSchema` (pdfPath, pdfOriginalName, sessionId, pdfHash, mode, rosterMode, rosterPath, dryRun)
- `handler.ts` — single-row handler: `dispatch` → `wait-signatures` → ServiceNow steps + restart/retry probes
- `wait-ocr-approval.ts` — `watchChildRuns` wrapper that resolves when the OCR row reaches `step="approved"` (`fannedOutItemIds` returned)
- `fill-form.ts` — Playwright form-fill + submit + ticket-number parser
- `duplicate-check.ts` — SHA-256 + prior-run scanner for the dashboard pre-flight
- `workflow.ts` — `defineWorkflow` + `runOathUpload` + `runOathUploadCli`
- `index.ts` — barrel

## Kernel Config

| Field         | Value                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `systems`     | `[{ id: "servicenow", login: loginToServiceNow }]`                                                                                     |
| `authSteps`   | `false` — the handler launches `ctx.page("servicenow")` lazily, AFTER `wait-signatures`                                                |
| `steps`       | `["dispatch", "wait-signatures", "servicenow-auth", "open-hr-form", "fill-form", "submit"]`                                            |
| `schema`      | `{ pdfPath, pdfOriginalName, sessionId, pdfHash, mode, rosterMode, rosterPath, dryRun }`                                               |
| `archetype`   | `"single"` — the oath-upload row is a flat top-level card. OCR + signer children parent to a synthesized oath-signature row, not this one |
| `batch`       | `{ mode: "sequential", preEmitPending: true, betweenItems: ["reset"] }` — daemon batches multiple PDFs per invocation                  |
| `tiling`      | (omitted — default)                                                                                                                    |
| `authChain`   | `"sequential"`                                                                                                                         |
| `detailFields`| PDF / OCR session / Signers / HR ticket # / Filed / Status. `data.uploadMode` carries `"full"` / `"upload-only"`. `data.signaturesParentRunId` (set by `dispatch`) records the synthesized oath-signature batch row's runId for cross-tab correlation |
| `runtimePolicy.subtitleTemplate` | `"Oath · <last4 run id>"` — matches the synthesized oath-signature batch row's subtitle for visual correlation across tabs    |

### Row archetypes emitted

| Row                            | Workflow tab     | Archetype         | Notes                                                                                  |
|--------------------------------|------------------|-------------------|----------------------------------------------------------------------------------------|
| Oath-upload daemon item        | oath-upload      | `single`          | Flat card. No nested children                                                          |
| Synthesized OCR-prep parent    | oath-signature   | `batch-parent`    | Created by `buildOcrPrepareHandler` with `originWorkflow: "oath-signature"`            |
| OCR delegated row              | ocr              | `batch-parent`    | `parentRunId` = synthesized parent's runId; nests under the synthesized row in oath-signature tab |
| Per-signer oath-signature      | oath-signature   | `delegate-child`  | `parentRunId` = synthesized parent's runId; nests under the synthesized row            |
| ServiceNow ticket              | (same oath-upload root row — terminal status update; no new row) |

## Dupe-protection

The dashboard's Run modal calls `/api/oath-upload/check-duplicate?hash=<sha256>`
on file select. If prior runs exist for that hash, a banner shows
date + terminal step + ticket number. **Non-blocking** — operator can
upload again. Hash is stored on every tracker line via
`data.pdfHash`. See `duplicate-check.ts`.

## Restart recovery

The handler's first action probes the OCR JSONL for any prior entry with
the same `ocrSessionId`. If a prior run reached `step="approved"`,
`dispatch` is skipped — `fannedOutItemIds` is read from the prior approved
entry and the handler jumps straight to `wait-signatures`. This makes
the handler idempotent on daemon restart (kernel re-claims the queue item
with the same runId via the existing `recoverOrphanedClaims` flow, the
handler re-enters from step 0, and the probe avoids re-firing the OCR
prepare).

## Soft-cancel

`POST /api/oath-upload/cancel` writes a `running` tracker entry on the
oath-upload row with `step="cancel-requested"`. Both `waitForOcrApproval`
and `watchChildRuns` calls have an `abortIfRowState` opt that polls the
parent's own row and rejects if the sentinel appears — so the daemon can
be in either of the two long waits and still cancel cleanly. After the
abort, the kernel's failure path emits `failed` step `"cancelled"`.

## Retry safety

**Idempotent across retry.** Contract 2 makes retry a uniform kernel behavior:
a retry assigns a NEW runId and replays the handler from step 0 with the
pristine original input. The pre-submit probe
`findPriorTicketForSession(input.sessionId, input.pdfHash, trackerDir)`
keys on stable business identity — `sessionId` (which equals the tracker
row `id` via `getId: (d) => d.sessionId`) and a defensive `pdfHash`
cross-check — both preserved across retries. If any prior entry for this
sessionId carries a filed `data.ticketNumber` (matching `/^HRC\d/i`,
excluding the dry-run sentinel), the handler stamps the prior ticket on
the new row and skips `servicenow-auth` / `open-hr-form` / `fill-form` /
`submit`.

The dashboard duplicate-check banner separately surfaces prior runs for
the same hash on file select — that's an operator-facing UX hint, not the
safety net. The kernel does not gate retry; idempotency belongs in the
workflow.

## Lessons Learned

- **Lesson maintenance rule:** Search this section and `src/workflows/ocr/CLAUDE.md` before adding oath-upload delegation lessons. Merge old restart/OCR notes into the current shared helper and runtime-shape rules.
- **2026-05-24: Oath Upload re-shaped from `delegating-batch` to `single`.** Children no longer nest under the oath-upload card. The handler's `dispatch` step calls `buildOcrPrepareHandler({ originWorkflow: "oath-signature" })` directly (instead of `ctx.delegateTo(ocrWorkflow, ...)`), which makes the OCR prepare endpoint synthesize a `batch-parent` row in the oath-signature tab. OCR + per-signer rows parent to that synthesized row, not to oath-upload. Oath-upload polls via `waitForOcrApproval` (OCR row by sessionId) + `watchChildRuns` (signers by fannedOutItemIds), then files the HR ticket. `ServiceNow` auth fires AFTER `wait-signatures` so the daemon doesn't hold an authenticated browser open across the (possibly multi-day) operator-approval wait.
- **OCR-delegating workflows need the roster picker.** Any Run modal for a workflow that depends on OCR roster matching must expose the same roster controls as the OCR modal. Never hardcode `rosterMode` at the dispatch site; thread `rosterMode` and `rosterPath` into the prepare call.
- **Use `data.uploadMode`, not `data.mode`.** `data.mode` was reserved for the prep-row `data.mode === "prepare"` compatibility check (renamed during the archetype migration). Dashboard read sites should dispatch on `resolveRowArchetype` / stamped `data.archetype`, not legacy task-role fields.
- **Restart recovery uses tracker helpers.** Prior OCR approval lookup uses `findLatestEntryForPredicate` so newest-first scanning and malformed-line tolerance stay shared. Do not reintroduce workflow-local `existsSync` / `readFileSync` JSONL loops.
