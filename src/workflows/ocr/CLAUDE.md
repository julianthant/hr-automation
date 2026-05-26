# OCR Workflow — `src/workflows/ocr/`

The "prep phase" of any form-based workflow. Operator uploads a PDF → OCR
runs the per-form Zod-bound LLM extraction → roster match → eid-lookup +
verification → preview row in the OCR tab → operator approves/discards/
reuploads → on approve, writes the terminal OCR row. Form specs with
`approveTo` (currently emergency-contact) also fan out downstream daemon rows
from the approve route; form specs without `approveTo` (currently oath) let
the owning workflow consume the approved row and fan out itself.

**Kernel-registered, NOT daemon-mode.** No browsers, no Duo. Runs in the
dashboard's Node process via fire-and-forget `runWorkflow` from
`/api/ocr/prepare`. Same shape as `sharepoint-download`.

**Archetype:** `delegating-batch` — the prep parent is a `batch-parent`,
utility lookup children stay flat delegation members, and approved target
workflow children render under the prep/root context.

### Row archetypes emitted

| Row                                | RowArchetype      | Dashboard surface              |
|------------------------------------|-------------------|--------------------------------|
| OCR prep parent (awaiting-approval) | `batch-parent`    | OCR group card (top-level)     |
| `eid-lookup` utility children (archetype `utility`) | `passive-child` | Flat `delegation-member` surface rows |
| `active-check` utility children (archetype `single`) | `delegate-child` | Flat `delegation-member` surface rows |
| Approved downstream children (`approveTo` forms only) | `delegate-child` | Nested under parent card       |

Note: `eid-lookup` and `active-check` both render flat as the `delegation-member` **surface type** (controlled by the OCR runtime policy's `delegation.utilityChildSurface`). However their RowArchetype differs: `eid-lookup` declares `archetype: "utility"` so `deriveRowArchetype` stamps `passive-child`; `active-check` declares `archetype: "single"` so children with a `parentRunId` resolve to `delegate-child`.

## Files

- `workflow.ts` — `defineWorkflow(...)` + thin handler that calls the
  orchestrator. `systems: []`, `authSteps: false`.
- `orchestrator.ts` — `runOcrOrchestrator(input, opts)` — pure async
  function with test escape hatches. Replaces the duplicated
  `prepare.ts` runners that lived in `oath-signature/` and
  `emergency-contact/`.
- `eid-lookup-results.ts` — shared OCR record patching helpers for applying
  terminal `eid-lookup` child outcomes.
- `form-registry.ts` — `FORM_SPECS = { oath, "emergency-contact" }`. One
  line to add a new form type once you've written its `ocr-form.ts`.
- `types.ts` — `OcrFormSpec<TOcr, TPreview, TFanOut>` contract.
- `carry-forward.ts` — `applyCarryForward({ v2, v1, spec })` — Levenshtein
  ≤ 2 fuzzy match by `spec.carryForwardKey`. Skips records flagged
  `forceResearch`.
- `schema.ts` — `OcrInputSchema` (Zod). Required fields:
  pdfPath, pdfOriginalName, formType, sessionId, rosterMode.
- `index.ts` — barrel.

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

1. Create `src/workflows/<consumer>/ocr-form.ts` exporting an
   `OcrFormSpec` object. Mirror oath/EC for prompt + match. Add `approveTo`
   only if the OCR approve route should enqueue downstream daemon rows.
2. Add a record renderer component in `src/dashboard/components/ocr/`
   (e.g. `MyFormRecordView.tsx`).
3. Add the spec to `FORM_SPECS` in `form-registry.ts`.
4. Run modal's picker auto-populates from `GET /api/ocr/forms`.

## Lessons Learned

- **Lesson maintenance rule:** Search this section plus the downstream form workflow docs before adding OCR lessons. Merge old per-form prep behavior into the current shared OCR orchestration model.
- **2026-05-26: `approveTo` is optional and controls approve-route fan-out.** Emergency-contact still declares `approveTo`, so `/api/ocr/approve-batch` enqueues downstream daemon rows and writes dependency rows. Oath omits `approveTo`; approve only emits `done step=approved` for OCR and wakes the `oath-signature` PDF handler, which reads the approved records and runs `ctx.delegateToAll` itself. Do not gate this behavior by form-type string in the approve handler — the presence of `spec.approveTo` is the contract.
- **2026-05-23: eid-lookup fan-out routes through `delegateToAllImpl`.** The orchestrator's `realEnqueue` used to call `ensureDaemonsAndEnqueue(eidLookupCrmWorkflow, ..., { parentRunId: runId, ... })` directly; Contract 3 moves that to `delegateToAllImpl({ child: eidLookupCrmWorkflow, renderAs: "flat", fireAndForget: true, onPreparedItems, deriveItemId, buildPendingExtras })`. The kernel owns parentRunId stamping + archetype derivation (`renderAs: "flat"` stamps `passive-child`, matching the runtime policy's `utilityChildSurface: "delegation-member"`). `fireAndForget: true` because the orchestrator's own `watchChildRuns` (`waitForChildRuns`) still drives the wait — wrapping a second wait inside `delegateToAllImpl` would double-count. SQLite task-dependency batch creation still hangs off the `onPreparedItems` hook, forwarded verbatim through the kernel primitive.
- **2026-05-24: `force-research.ts` + `retry-page.ts` also route through `delegateToAllImpl` (Finding #23).** They previously called `ensureDaemonsAndEnqueue` directly from HTTP entrypoints (no parent `ctx`), and were the only two surviving entries in `tests/unit/architecture/delegate-to-usage.test.ts`'s orchestrator allow-list. Both now follow the orchestrator's shape — `renderAs: "flat"` + `fireAndForget: true` + `deriveItemId` + `parentRunId: input.runId` — so the OCR session is the parent of every eid-lookup child, and child pending rows stamp `passive-child` via the kernel's archetype derivation. The two files remain on `delegate-to-all-impl-callers.test.ts`'s allow-list alongside the orchestrator (they need direct access to `delegateToAllImpl` because they run outside a workflow `ctx`); the `delegate-to-usage` allow-list is gone.
- **Runtime policy owns OCR preview behavior.** `ocrWorkflow.metadata.runtimePolicy` declares preview labels, file-scope cancel behavior, and utility-child surfaces. Queue projections should read policy instead of adding workflow-id checks; EID Lookup / Active Check utility rows stay flat delegation members.
- **Origin prep rows are the handoff.** `writeOriginParentPending` emits the main prep row and OCR delegation logs, but no synthetic request child row. Post-approval daemon children attach under the prep parent.
- **Multi-file uploads are independent.** `/api/ocr/prepare` no longer accepts `originBatchRunId` or `originBatchSubject`; selecting N PDFs fires N standalone prepare requests, each with its own top-level prep row/card.
- **Phase logs and parent context are deliberate.** `runOcrOrchestrator` emits plain `Phase: <step>` markers, and delegated OCR rows inherit parent context via `parentSubject` / optional `originWorkflow` while person lookup rows keep their own person/EID title.
- **Matching flow:** OCR records may carry confidence; high-confidence signed names can skip LLM roster disambiguation, no-candidate lookup suggestions collapse to the longest complete variant, and form specs patch records via `applyDisambiguation` where needed.
- **Operator discard must clean abort state.** Always clear `clearOcrPrepareAbort(id, runId)` in `finally`; tracker failure writes inside the abort path need their own inner try/catch so they cannot strand the abort flag.
- **Force research consumes child outcomes.** Apply every `eid-lookup` outcome through `patchOcrRecordFromEidLookupOutcome` before emitting the final awaiting-approval row; use explicit `null` when clearing fields so JSON preserves the keys.
- **Latest-row probes use tracker helpers.** Use `findLatestEntryForPredicate` for newest-first OCR row lookup; avoid workflow-local full-file JSONL loops.
- **Retrying failed lookup dependencies reopens the dependency.** Bulk retry must send `{id, runId}` so the SQLite retry path can reset the matching OCR dependency to `pending`; the approval pane stays disabled until the scheduler patches the retried result back into `data.records`.
- **Manual-fill and empty-page UX:** The `disambiguating` phase, `data.emptyPages`, empty-page cards, per-page add-row controls, and `employeeId` approval gate are part of the current review model; keep renderer changes aligned with `OcrFormSpec.applyDisambiguation`.
