# Delegation, cross-daemon waits, and OCR approve fan-out

How workflows compose. Source: `src/core/delegate.ts`, `src/core/kernel/types.ts` (`Ctx`), `src/workflows/ocr/`, `src/services/ocr/forms/`, `src/tracker/dashboard/ocr/approve.ts`.

## 1. Parent → child delegation

Delegation routes **only** through the kernel:

```ts
ctx.delegateTo(childWorkflow, childInput, opts?)        // one child, awaited
ctx.delegateToAll(childWorkflow, [input1, input2], opts?) // N children
```

The kernel owns: stamping `parentRunId = ctx.runId` on every child row, pre-emitting the pending child row (with archetype), persisting pristine input (`tasks.original_input_json` for daemon children; the pending row's `input` for in-process), and awaiting children (`watchChildRuns` for daemon children, the per-run promise for in-process).

**Guard-forbidden:** direct child `runWorkflow(...parentRunId...)` and child `ensureDaemonsAndEnqueue(...parentRunId...)`. An architecture guard fails the build if you bypass `delegateTo`/`delegateToAll`.

`opts` of note:
- `fireAndForget: true` — enqueue/launch the child, parent returns immediately (`status: "pending"`), does not await.
- `renderAs: "flat"` — each child renders as its own `single` row grouped under the parent `parentRunId` (OCR → person-lookup fan-out uses this).

**Daemon vs in-process children:** daemon-capable children (in `WORKFLOW_LOADERS`) route through enqueue + SQLite. Non-daemon children (e.g. OCR, sharepoint-download) run in-process via `runWorkflow`. The fan-out watch key is the **child workflow name** (`"person-lookup"`), not the phase/step label.

## 2. Cross-daemon wait (`watchChildRuns`)

When a workflow must wait on rows enqueued by a **different** parent/daemon (not its own delegated children), use `watchChildRuns` directly:

```ts
await watchChildRuns({ workflow: "oath-signature", expectedItemIds: signerItemIds });
```

It requires every named itemId to reach `status === "done"`, throws if any is missing/failed/cancelled, and is **idempotent across retry** — re-watching already-finished rows just returns. This is how `oath-upload`'s `wait-signatures` step blocks on the OCR-fanned signer rows without holding its own daemon's single worker. The deadlock lesson: never `delegateToAll(self)` onto your own single-worker daemon while holding it — full symptom/root-cause/fix in `references/pitfalls.md`.

## 3. OCR approve fan-out (form-spec driven)

OCR is a prep/approval **hub**. What it fans out on approve is declared on the `OcrFormSpec` (`src/services/ocr/forms/<form>.ts`), not in the approve route. Two independent targets:

- **`approveTo` (per-record)** — one downstream daemon row per approved record.
  ```ts
  approveTo: {
    workflow: "oath-signature",
    deriveInput: (record) => buildSignerInput(record),
    deriveItemId: (record, parentRunId, index) => `ocr-oath-${parentRunId}-r${index}`,
    canFanOut: (record) => hasSignerInput(record), // optional: skip selected-but-incomplete records
  }
  ```
- **`approveDocumentTo` (once-per-document)** — exactly one downstream row per approved PDF, handed `perRecordItemIds` (the itemIds the per-record fan-out actually enqueued) so it can wait on exactly those rows.
  ```ts
  approveDocumentTo: {
    workflow: "oath-upload",
    deriveInput: (doc) => ({ /* ...doc.perRecordItemIds → signerItemIds... */ }),
    deriveItemId: (doc) => `ocr-oath-upload-${doc.runId}`,
  }
  ```

A spec may declare **either, both, or neither**. With neither, the approve route just writes the terminal OCR row and the owning workflow consumes the approved records itself. The two oath targets run on **different daemons** so neither waits on its own daemon's children (the OCR-hub fan-out that fixes the single-worker deadlock). Forms with `approveTo` or `approveDocumentTo` automatically show an "Approve" button (`hasApproveFanOut` in `registry.ts`).

`/api/ocr/approve-batch` (`src/tracker/dashboard/ocr/approve.ts`) reads the spec, filters to `selected` records, applies `canFanOut`, enqueues per-record then once-per-document, and parents children under `parentRunId ?? input.runId`.

## 4. Adding a new OCR form type

1. Create `src/services/ocr/forms/<form>.ts` exporting an `OcrFormSpec` (mirror `oath.ts` / `emergency-contact.ts`): `formType`, `label`, `description`, `prompt`, `ocrRecordSchema`, `ocrArraySchema`, `matchRecord`, `needsLookup`, carry-forward helpers, optional `approveTo` / `approveDocumentTo`, `recordRendererId`, `rosterMode`.
2. Add a record renderer component in `src/dashboard/components/ocr/` (e.g. `MyFormRecordView.tsx`) and reference it via `recordRendererId`.
3. Register in `FORM_SPECS` in `src/services/ocr/forms/registry.ts`. The run-modal picker auto-populates from `GET /api/ocr/forms`.

The OCR form **type is selected, not auto-detected** today: `/api/ocr/prepare` takes a `formType` field and `getFormSpec(formType)` looks it up. There is currently no form-type detection pass.

## 5. Where a new subworkflow's shared logic lives

- Operator-facing or daemon-target workflow → `src/workflows/<name>/`.
- System driver/selectors (UCPath, CRM, i9, …) → `src/systems/<system>/`.
- OCR-specific prompt/match/spec → `src/services/ocr/forms/`.
- Cross-workflow domain helpers (presentation, classification) → `src/domain/`.
- A delegated-only subworkflow is a normal workflow registered in `WORKFLOW_LOADERS` + eager-imported, but with **no** dashboard start surface — its only entry is a parent's `ctx.delegateTo`.

## 6. Trace identity across a fan-out (trace / span)

Every row of one operation DISPLAYS a shared trace prefix; each row keeps its own tail. Source: `src/domain/queue-trace-id.ts`, `src/core/delegate.ts`, `src/core/pending-data.ts`, the two seed paths (`run-one-item.ts` / `run-workflow.ts`).

- **Format:** `<code>-<HHMMSS>-<runId4>`. The **prefix** `<code>-<HHMMSS>` is the operation (*trace*); the **tail** `<runId4>` is the row (*span*).
- **Propagation:** the root's prefix rides `rootTracePrefix` on the child input's `__runtimeOptions` (parallel to `rootCode`), survives the SQLite task store, and is read back in **both** seed paths. A delegated child composes `<rootPrefix>-<ownRunId4>` (its OWN tail via `buildTraceId({ …, rootPrefix })`) — **not** the parent's full id. `findFrozenTraceId` stays the FIRST fallback so a same-run re-emit reuses the row's already-frozen id (the frozen-once invariant).
- **Transitive:** `makeCtx` forwards `rootTracePrefix = inherited ?? tracePrefix(findFrozenTraceId(self))`, so a grandchild shares the ORIGINAL root's prefix (the `parentSubject` pattern), not the middle parent's.
- **Branding by operation:** an `OcrFormSpec` may set `traceCode` (oath → `ou`) so the OCR root is branded by the operation the operator started, not OCR's own `oc`. Standalone OCR / emergency-contact keep `oc`.
- **HTTP fan-out (outside a `ctx`):** a route that enqueues children directly (e.g. `src/tracker/dashboard/ocr/approve.ts`) has no `ctx` auto-forward — it must read the root's frozen id via `findFrozenTraceId` and stamp `rootTracePrefix: tracePrefix(rootId)` on each enqueued input's `__runtimeOptions` itself. Forgetting this leaves a half-migration (some children share the prefix, some don't).

DISPLAY only — each row keeps its own `runId` / `itemId` (logs, SQLite, footer `#run`). Full mechanism + the lockstep-seed-paths gotcha: `src/core/CLAUDE.md` ("Root trace-id propagation"). The failure mode is in `references/pitfalls.md`.
