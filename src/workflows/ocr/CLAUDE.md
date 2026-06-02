# OCR Workflow — `src/workflows/ocr/`

The "prep phase" of any form-based workflow. Operator uploads a PDF → OCR
runs the per-form Zod-bound LLM extraction → roster match → eid-lookup +
verification → preview row in the OCR tab → operator approves/discards/
reuploads → on approve, writes the terminal OCR row and fans out downstream
daemon rows.

**Approve fan-out is form-spec driven, with TWO independent targets:**
- `approveTo` (**per-record**) — one downstream row per approved record.
  emergency-contact → an EC daemon row; oath → an oath-signature EID signer row.
  An optional `approveTo.canFanOut(record)` skips a selected-but-incomplete
  record (oath: no resolved EID) so the per-record itemIds stay in sync with
  what is actually enqueued.
- `approveDocumentTo` (**once-per-document**) — exactly one downstream row per
  approved PDF, handed `perRecordItemIds` (the itemIds the per-record fan-out
  produced) so it can wait on exactly those rows. oath → one oath-upload ticket
  row that waits for all the signer rows before filing.

A spec may declare either, both, or neither. With neither, the approve route
just writes the terminal OCR row and the owning workflow consumes it. The two
oath targets run on DIFFERENT daemons, so neither waits on its own daemon's
children (the OCR-hub fan-out that fixes the oath single-worker deadlock).
Fanned-out children parent under the OCR run itself when OCR ran standalone
(`childParentRunId = parentRunId ?? ocrRunId`).

**Kernel-registered, NOT daemon-mode.** No browsers, no Duo. Runs in the
dashboard's Node process via fire-and-forget `runWorkflow` from
`/api/ocr/prepare`. Same shape as `sharepoint-download`.

**Archetype:** `preview` — the prep parent is an OCR review/approval row;
child/delegated scope is represented by `parentRunId`. Lookup wait behavior is
owned by the OCR orchestrator and SQLite task dependencies, not by child row
archetype.

### Row archetypes emitted

| Row                                | RowArchetype      | Dashboard surface              |
|------------------------------------|-------------------|--------------------------------|
| OCR prep parent (awaiting-approval) | `preview` | OCR review card |
| `person-lookup` children | `single` + `parentRunId` plus runtime-policy delegated grouping | Batch surface even for one delegated OCR person |
| Approved downstream children (`approveTo` / `approveDocumentTo` forms) | natural child shape + `parentRunId` (the OCR run when standalone) | Nested under the OCR card |

## EID lookup dependency mode

The first OCR `eid-lookup` fan-out uses SQLite task dependencies. The OCR
handler still returns at `awaiting-approval`; the scheduler patches records as
child lookup runs finish. If dependency setup fails before queue append, OCR
falls back to the old `watchChildRuns` path. Force-research and whole-PDF
re-OCR still use `watchChildRuns` during Phase 2.

Retrying a failed dependency child must keep the original child task id. The
dashboard retry path uses the failed run id to create a new task attempt, then
reopens the corresponding `ocr-eid-lookup` / `ocr-active-check` dependency to
`pending`. That keeps the OCR preview blocked from approval while the retry is
queued/running and lets the scheduler patch `data.records` when the retry
finishes.

## Adding a new form type

1. Create the `OcrFormSpec` object (oath/EC live in `src/services/ocr/forms/`).
   Mirror oath/EC for prompt + match. Add `approveTo` to enqueue one downstream
   daemon row per approved record; add `approveDocumentTo` to additionally
   enqueue one row per PDF (e.g. a ticket/upload row that waits on the
   per-record rows).
2. Add a record renderer component in `src/dashboard/components/ocr/`
   (e.g. `MyFormRecordView.tsx`).
3. Add the spec to `FORM_SPECS` in `form-registry.ts`.
4. Run modal's picker auto-populates from `GET /api/ocr/forms`.

## Lessons Learned

- **Lesson maintenance rule:** Search this section plus the downstream form workflow docs before adding OCR lessons. Merge old per-form prep behavior into the current shared OCR orchestration model.
- **2026-06-02: The oath operation brands `ou`; every fan-out row SHARES the OCR root's `ou-…` PREFIX with its own tail (root trace-id propagation, trace/span model).** OCR is the physical root of the oath prep tree, but the operator's mental model is "I uploaded to Oath Upload." `oathOcrFormSpec.traceCode = "ou"` brands the OCR root run's trace id `ou-<HHMMSS>-<runId4>` (orchestrator computes it at `buildTraceId({ code: spec.traceCode ?? "oc", … })`); standalone OCR + emergency-contact keep `oc`. The root PREFIX (`ou-<HHMMSS>`) then propagates to EVERY descendant, each COMPOSING `<prefix>-<ownRunId4>` — person-lookups (orchestrator passes `rootTracePrefix: tracePrefix(traceId)` on the `delegateToAllImpl` fan-out), and the on-approve signer rows + oath-upload ticket (approve.ts reads the OCR row's frozen id via `findFrozenTraceId` and stamps `rootTracePrefix: tracePrefix(...)` on each enqueued input's `__runtimeOptions`). So the whole operation reads `ou-090553-<eachOwnRunId4>` — visibly one operation, each row individually greppable. DISPLAY-only — the execution/delegation graph is unchanged (OCR stays the hub; oath-signature and oath-upload remain siblings; deadlock-safe). Each row keeps its own runId/itemId. Kernel mechanism + lockstep seed-path detail in `src/core/CLAUDE.md` ("Root trace-id propagation"). Pinned by `orchestrator.test.ts` (oath form → `ou-…`; EC → `oc-…`) + `ocr-approve-oath-fanout.test.ts`.
- **2026-06-02: The lookup fan-out watch key is the CHILD workflow name (`person-lookup`), NOT the phase label.** `runFanOutPhase` in `orchestrator.ts` takes a `kind` used only as the tracker `step` + log label (now `"person-lookup"`); the `watchChildren({ workflow })` call MUST hardcode `"person-lookup"` (the workflow the fan-out delegates to via `delegateToAllImpl({ child: personLookupWorkflow })`). `watchChildRuns` keys on that name for BOTH its SQLite (`listTasksForWorkflow`) and JSONL (`rowFilePath`) lookups, so a stale/mismatched name matches zero rows and the watcher silently hangs the full `timeoutMs` (1h). The 2026-05-28 `eid-lookup→person-lookup` rename fixed `force-research.ts`/`retry-page.ts`/`reocr-whole-pdf.ts` but missed this orchestrator site, which watched the phase label. Pinned by `orchestrator.test.ts` ("dispatches eid-lookup by EID…" asserts `watchedWorkflow === "person-lookup"`). The OCR pipeline `step` is now `person-lookup` (renamed from `eid-lookup`) end-to-end: `ocrSteps`, orchestrator emits, `OcrQueueRow` STAGES, `OcrReviewPane` step gate, `formatStepName`. `matchSource: "eid-lookup"` (record provenance) and the `ocr-eid-lookup` dependency kind are NOT steps — left unchanged.
- **2026-06-02: The OCR approval wait MUST work cross-process — the JSONL backstop reads `rows/`, not the flat tracker dir.** `subscribeToApproval` (`src/services/ocr/approval-signal.ts`) has two wake-ups: the in-memory `emitApproved` and a JSONL backstop poll. For oath-upload the OCR handler runs **in-process inside the oath-signature DAEMON** (`ctx.delegateTo(ocrWorkflow)`), but the operator approves via the **dashboard** process (`/api/ocr/approve-batch`). The in-memory signal can't cross processes, so the JSONL poll is the only thing that wakes the daemon. It was reading the legacy flat path `join(trackerDir, "ocr-<date>.jsonl")`, but the 2026-06-01 tracker restructure moved rows to `.tracker/rows/` — so the poll always read a non-existent file, never saw the approve, and oath-signature stalled forever at `step=ocr` with no `delegate-signatures` fan-out. Fix: read via `rowFilePath("ocr", date, trackerDir)`. **Rule:** every tracker reader uses `paths.ts` helpers (`rowFilePath`/`rowsDir`/…), never a hand-spelled `.tracker/<file>` — the restructure sweep missed readers outside `src/tracker/`/`src/control/` (this one in `src/services/`; cf. the earlier `oath-upload/duplicate-check.ts` miss). Pinned by `approval-signal.test.ts` (backstop reads `rows/`; a stale flat-path row is NOT picked up).
- **2026-06-02: A delegated OCR run must re-stamp `parentRunId` on EVERY self-emitted row.** The orchestrator emits its own rich running/awaiting-approval snapshots (bypassing kernel row emission) and the dashboard collapses a run to its LATEST row. `parentRunId` is delegated scope; the kernel stamps it on the rows IT emits (pending/terminal) but delegation never puts it in the child *input* (it's a kernel option, not an input field). So the orchestrator's snapshots dropped it → the dashboard saw the latest row as standalone → `OcrReviewPane` hid the Approve button (`isDelegation = prepActive && entry.parentRunId`). Fix: `ctx.parentRunId` is now exposed (threaded `run-workflow`/`run-one-item` → `handler-runner` → `makeCtx`) and `ocrKernelHandler` forwards it as `input.parentRunId` into the orchestrator, which already re-stamps it in `writeTracker`. Same bug class as the mode/archetype/`__id`/`__traceId` re-stamp rules — `parentRunId` just wasn't in the re-stamp set. Pinned by `orchestrator.test.ts` ("delegated orchestrator re-stamps parentRunId on EVERY self-emitted row").
- **2026-06-01: A failed OCR prep row must stay a *preview* row (keep its Preview tab).** OCR has TWO emission channels for the same `(id, runId)`: the orchestrator's direct `emitTrackerRow` (rich — `mode:"prepare"`, `records`, `pageImagesDir`, page metadata) and the kernel's auto-emitted terminal row built from accumulated `ctx` data. On the **success/awaiting-approval** path the orchestrator's row stays latest (the handler suspends in `subscribeToApproval`), so the live Preview tab works. On **failure** the orchestrator rethrows → the kernel emits its own terminal `failed` row LAST, and it's sparse (no `mode`, no `records`). The dashboard collapses a run to its *latest* row (`dedupeLatestByIdWithCarriedEmplId`, latest-wins-wholesale), so the sparse kernel row clobbered the rich one — `App.tsx`'s Preview gate (`workflow==="ocr" && data.mode==="prepare"`) then failed → no Preview tab on the failed card (and the title regressed from the PDF filename to the form label). Fix mirrors the approve-path `ctx.updateData` pattern: the orchestrator surfaces its last rich snapshot via a new `onReviewData(data)` opt (called in `emitSnapshot`) and also re-stamps it onto its own `failed` row; `ocrKernelHandler` captures it and, in a `catch` around `runOcrOrchestrator`, calls `ctx.updateData({ ...reviewData, mode:"prepare" })` before rethrowing (stripping kernel-owned `parentRunId`). `ctx.updateData` on the real-run path only merges into accumulated `data` (no extra emit), so the kernel's single terminal `failed` row carries the prep identity + records. Same bug class as core's "Sparse terminal rows overwrite rich pending rows in dashboard dedupe." Pinned by `orchestrator.test.ts` ("terminal failed row keeps the rich preview payload").
- **2026-06-01: OCR drives the session-drawer timeline via `ctx.reportPhase`.** OCR owns its own queue-row emission (`runOcrOrchestrator` → `emitTrackerRow`) and so bypasses `ctx.step`. That meant its session row appeared (from `workflow_start`) but never emitted `step_change`/`item_start`, so the terminal-drawer `WorkflowBox` timeline stayed static while every browser workflow advanced. Fix: the orchestrator takes an `onPhase(step)` callback, invoked at its single `emit` chokepoint for every `running` row (so all phases — `loading-roster`→…→`awaiting-approval` — fire, including snapshots via `writeTracker`/`emitSnapshot`); `ocrKernelHandler` wires `onPhase: (step) => ctx.reportPhase(step)`. `ctx.reportPhase` (new kernel capability) emits session `item_start` (once) + `step_change` for the run's `ctx.workflowInstance` **without** a queue row, coalescing repeats. The instance is threaded kernel-side: `run-workflow`/`run-one-item` → `runWorkflowHandler({ instance })` → `makeCtx`. Direct child emits (person-lookup fan-out at orchestrator.ts ~737) correctly bypass `onPhase` (they're child rows, not OCR parent phases). Pinned by `tests/unit/workflows/ocr/orchestrator.test.ts` ("drives the session timeline via onPhase").
- **2026-06-02: Approve fan-out has TWO form-spec targets — `approveTo` (per-record) + `approveDocumentTo` (once-per-document).** `/api/ocr/approve-batch` enqueues one row per approved record via `approveTo` (EC daemon row / oath-signature signer row) AND, if present, exactly one row per PDF via `approveDocumentTo` (oath-upload ticket row). The doc target's `deriveInput(doc)` receives `{ records, sessionId, runId, perRecordItemIds, pdfOriginalName, pdfFileId, pdfHash?, pdfPath?, dryRun }` — `perRecordItemIds` are the itemIds the per-record fan-out ACTUALLY enqueued (filtered by `approveTo.canFanOut`), so the doc target waits on exactly those rows. Oath declares both; the two targets land on DIFFERENT daemons (oath-signature + oath-upload), so neither waits on its own daemon's children — fixing the prior `delegateToAll(self)` single-worker deadlock. Specs with neither target keep the "owner consumes" behavior. Do not gate by form-type string — `spec.approveTo` / `spec.approveDocumentTo` presence is the contract. `GET /api/ocr/forms` exposes `hasApproveFanOut` so the review pane shows Approve on a standalone OCR run (no parentRunId) when the form fans out. Children parent under the OCR run itself when standalone (`childParentRunId = parentRunId ?? ocrRunId`). Pinned by `ocr-approve-oath-fanout.test.ts` + `ocr-http.test.ts`.
- **2026-05-27 / 2026-06-02: person-lookup fan-out stamps single + parentRunId, then runtime policy groups delegated members.** The orchestrator, force-research, and retry-page routes still use `delegateToAllImpl({ child: personLookupWorkflow, renderAs: "flat", fireAndForget: true, deriveItemId, ... })`. For `renderAs: "flat"`, the kernel stamps lookup rows `single`; `parentRunId` ties them to the OCR session. Person Lookup's `delegation.alwaysBatchDelegatedMembers` policy then makes even one delegated lookup render as a one-member batch surface in the Person Lookup tab. OCR still waits through SQLite task dependencies or `watchChildRuns`.
- **2026-05-24: `force-research.ts` + `retry-page.ts` also route through `delegateToAllImpl` (Finding #23).** They previously called `ensureDaemonsAndEnqueue` directly from HTTP entrypoints (no parent `ctx`), and remain on `delegate-to-all-impl-callers.test.ts`'s allow-list alongside the orchestrator because they need stable per-record item IDs and their own `watchChildRuns` wait.
- **2026-05-27 / 2026-06-02: OCR is a preview archetype.** `ocrWorkflow.metadata.runtimePolicy` declares preview labels and file-scope cancel behavior. Person Lookup utility rows keep their natural `single` row archetype plus OCR `parentRunId`, and Person Lookup's runtime policy groups delegated rows as a batch surface even when there is only one child.
- **2026-05-26: Legacy cross-tab parent synthesis is deleted.** OCR prepare no longer creates parent rows in consumer workflow tabs. Parent context is explicit `parentRunId` / `parentSubject` from kernel delegation; `/api/ocr/prepare` is a standalone OCR entrypoint.
- **Multi-file uploads are independent.** `/api/ocr/prepare` no longer accepts `originBatchRunId` or `originBatchSubject`; selecting N PDFs fires N standalone prepare requests, each with its own top-level prep row/card.
- **Phase logs and parent context are deliberate.** `runOcrOrchestrator` emits plain `Phase: <step>` markers, and delegated OCR rows inherit parent context via explicit `parentSubject` while person lookup rows keep their own person/EID title.
- **Matching flow:** OCR records may carry confidence; high-confidence signed names can skip LLM roster disambiguation, no-candidate lookup suggestions collapse to the longest complete variant, and form specs patch records via `applyDisambiguation` where needed.
- **Operator discard must clean abort state.** Always clear `clearOcrPrepareAbort(id, runId)` in `finally`; tracker failure writes inside the abort path need their own inner try/catch so they cannot strand the abort flag.
- **Force research consumes child outcomes.** Apply every `eid-lookup` outcome through `patchOcrRecordFromEidLookupOutcome` before emitting the final awaiting-approval row; use explicit `null` when clearing fields so JSON preserves the keys.
- **Latest-row probes use tracker helpers.** Use `findLatestEntryForPredicate` for newest-first OCR row lookup; avoid workflow-local full-file JSONL loops.
- **Retrying failed lookup dependencies reopens the dependency.** Bulk retry must send `{id, runId}` so the SQLite retry path can reset the matching OCR dependency to `pending`; the approval pane stays disabled until the scheduler patches the retried result back into `data.records`.
- **Manual-fill and empty-page UX:** The `disambiguating` phase, `data.emptyPages`, empty-page cards, per-page add-row controls, and `employeeId` approval gate are part of the current review model; keep renderer changes aligned with `OcrFormSpec.applyDisambiguation`.
