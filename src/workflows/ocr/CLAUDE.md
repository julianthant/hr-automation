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

**Archetype:** `preview` — the prep parent is an OCR review/approval row;
child/delegated scope is represented by `parentRunId`. Lookup wait behavior is
owned by the OCR orchestrator and SQLite task dependencies, not by child row
archetype.

### Row archetypes emitted

| Row                                | RowArchetype      | Dashboard surface              |
|------------------------------------|-------------------|--------------------------------|
| OCR prep parent (awaiting-approval) | `preview` | OCR review card |
| `person-lookup` children | `single` + `parentRunId` | Single if one OCR person; batch surface if multiple |
| Approved downstream children (`approveTo` forms only) | natural child shape + `parentRunId` | Nested under parent card |

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
- **2026-06-01: OCR drives the session-drawer timeline via `ctx.reportPhase`.** OCR owns its own queue-row emission (`runOcrOrchestrator` → `emitTrackerRow`) and so bypasses `ctx.step`. That meant its session row appeared (from `workflow_start`) but never emitted `step_change`/`item_start`, so the terminal-drawer `WorkflowBox` timeline stayed static while every browser workflow advanced. Fix: the orchestrator takes an `onPhase(step)` callback, invoked at its single `emit` chokepoint for every `running` row (so all phases — `loading-roster`→…→`awaiting-approval` — fire, including snapshots via `writeTracker`/`emitSnapshot`); `ocrKernelHandler` wires `onPhase: (step) => ctx.reportPhase(step)`. `ctx.reportPhase` (new kernel capability) emits session `item_start` (once) + `step_change` for the run's `ctx.workflowInstance` **without** a queue row, coalescing repeats. The instance is threaded kernel-side: `run-workflow`/`run-one-item` → `runWorkflowHandler({ instance })` → `makeCtx`. Direct child emits (person-lookup fan-out at orchestrator.ts ~737) correctly bypass `onPhase` (they're child rows, not OCR parent phases). Pinned by `tests/unit/workflows/ocr/orchestrator.test.ts` ("drives the session timeline via onPhase").
- **2026-05-26: `approveTo` is optional and controls approve-route fan-out.** Emergency-contact still declares `approveTo`, so `/api/ocr/approve-batch` enqueues downstream daemon rows and writes dependency rows. Oath omits `approveTo`; approve only emits `done step=approved` for OCR and wakes the `oath-signature` PDF handler, which reads the approved records and runs `ctx.delegateToAll` itself. Do not gate this behavior by form-type string in the approve handler — the presence of `spec.approveTo` is the contract.
- **2026-05-27: person-lookup fan-out stamps single + parentRunId.** The orchestrator, force-research, and retry-page routes still use `delegateToAllImpl({ child: personLookupWorkflow, renderAs: "flat", fireAndForget: true, deriveItemId, ... })`. For `renderAs: "flat"`, the kernel stamps lookup rows `single`; `parentRunId` ties them to the OCR session. `renderAs: "batch"` is the separate opt-in for batch-member fan-out. OCR still waits through SQLite task dependencies or `watchChildRuns`.
- **2026-05-24: `force-research.ts` + `retry-page.ts` also route through `delegateToAllImpl` (Finding #23).** They previously called `ensureDaemonsAndEnqueue` directly from HTTP entrypoints (no parent `ctx`), and remain on `delegate-to-all-impl-callers.test.ts`'s allow-list alongside the orchestrator because they need stable per-record item IDs and their own `watchChildRuns` wait.
- **2026-05-27: OCR is a preview archetype.** `ocrWorkflow.metadata.runtimePolicy` declares preview labels and file-scope cancel behavior. Person Lookup utility rows keep their natural `single` row archetype plus OCR `parentRunId`; one child renders as a single delegated row, multiple siblings group as a batch surface in the utility workflow tab.
- **2026-05-26: Legacy cross-tab parent synthesis is deleted.** OCR prepare no longer creates parent rows in consumer workflow tabs. Parent context is explicit `parentRunId` / `parentSubject` from kernel delegation; `/api/ocr/prepare` is a standalone OCR entrypoint.
- **Multi-file uploads are independent.** `/api/ocr/prepare` no longer accepts `originBatchRunId` or `originBatchSubject`; selecting N PDFs fires N standalone prepare requests, each with its own top-level prep row/card.
- **Phase logs and parent context are deliberate.** `runOcrOrchestrator` emits plain `Phase: <step>` markers, and delegated OCR rows inherit parent context via explicit `parentSubject` while person lookup rows keep their own person/EID title.
- **Matching flow:** OCR records may carry confidence; high-confidence signed names can skip LLM roster disambiguation, no-candidate lookup suggestions collapse to the longest complete variant, and form specs patch records via `applyDisambiguation` where needed.
- **Operator discard must clean abort state.** Always clear `clearOcrPrepareAbort(id, runId)` in `finally`; tracker failure writes inside the abort path need their own inner try/catch so they cannot strand the abort flag.
- **Force research consumes child outcomes.** Apply every `eid-lookup` outcome through `patchOcrRecordFromEidLookupOutcome` before emitting the final awaiting-approval row; use explicit `null` when clearing fields so JSON preserves the keys.
- **Latest-row probes use tracker helpers.** Use `findLatestEntryForPredicate` for newest-first OCR row lookup; avoid workflow-local full-file JSONL loops.
- **Retrying failed lookup dependencies reopens the dependency.** Bulk retry must send `{id, runId}` so the SQLite retry path can reset the matching OCR dependency to `pending`; the approval pane stays disabled until the scheduler patches the retried result back into `data.records`.
- **Manual-fill and empty-page UX:** The `disambiguating` phase, `data.emptyPages`, empty-page cards, per-page add-row controls, and `employeeId` approval gate are part of the current review model; keep renderer changes aligned with `OcrFormSpec.applyDisambiguation`.
