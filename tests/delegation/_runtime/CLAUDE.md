# Delegation Runtime — Salvaged Projection Tooling

Moved here wholesale from `tests/scenarios/_runtime/` via `git mv` (history preserved).

## snapshot-row.ts — stable salvaged projection tool

`snapshotRow`, `snapshotGroupAnchor`, and `readRowTimeline` route rows through the **same** pipeline the React queue panel uses:

1. `buildTrackerQueueSurfaces` — assembles raw surfaces from tracker JSONL.
2. Two-stage collapse:
   - `dedupeLatestByIdWithCarriedEmplId` — latest row per `id` (stage 1, required).
   - `groupMergedTrackerEntries` — one primary per merge key (stage 2).
3. `resolveQueueRowStatus` + the workflow's `statusExtensions` — derives `statusLabel` / `secondaryTag`.
4. `buildProjectionFromQueueSurface` with `preferTraceIdSubtitle: true` — derives title, subtitle, footer fields.

**Do NOT reimplement status or projection logic in tests.** A status/subtitle/title bug in source surfaces as a snapshot diff.

## Snapshot-fidelity rules (do not regress)

- **Group-anchor subtitle** = trace id for person batch/preview anchors (never a repeated member EID). File/catalog anchors also use trace id. Use `snapshotGroupAnchor` (not `snapshotRow`) to exercise this path.
- **Two-stage collapse is required.** Skipping stage 1 (`dedupeLatestByIdWithCarriedEmplId`) ties the `activityTimestamp` sort across a run's pending/running/done rows (they share `firstLogTs`) and flakily picks a stale primary.
- **Trace ids are auto-scrubbed** by the snapshot helpers — no manual masking needed for them.

## The harness — `createDelegationRuntime` (Phase 1 Task 7, landed)

`runtime.ts` drives **one-or-more real daemons against a temp tracker root** (no browser — every daemon uses `Session.forTesting` via `stubLaunch()`). All JSONL, `state.db`, and daemon lockfiles land under the temp dir; the real `.tracker/` is never touched. Import everything from `./_runtime/index.js`.

```ts
const rt = await createDelegationRuntime({
  workflows: [
    // spec → built with the runtime's own GateCoordinator
    { name: "child-wf", code: "cw", stages: ["load", "transaction", "finalize"],
      gatedStages: ["transaction"], archetype: "single", inputSubject: "name" },
    // OR with N racing daemon instances (needed to hold N children of ONE
    // workflow concurrently — a single daemon's claim loop is serial):
    { workflow: { name: "child-wf", stages: ["transaction"] }, instances: 3 },
    // OR a pre-built RegisteredWorkflow (e.g. a custom-handler parent).
  ],
})
```

### API

| Method | What it does |
|---|---|
| `rt.enqueue(wf, input?, { runId?, parentRunId?, itemId?, renderAs? })` | `enqueueItems` one item + wakes the daemon(s). `parentRunId` stamps `tasks.parent_run_id` (independent-child fan-out). `renderAs:"batch"` **merges** `rowShape:"batch-member"` into the input's `__runtimeOptions` (mirrors `withBatchMemberRuntimeOptions`) so the row renders as a delegated batch member. The **merge** (not clobber) PRESERVES any `rootTracePrefix` the real approve route already stamped on the input — so fan-out children COMPOSE `<rootPrefix>-<ownRunId4>` and root trace-id propagation stays faithful (P2.10 fix; a clobber would strip it and the child would fall back to its own workflow code). Returns `{ runId, itemId }`. |
| `rt.waitForEvent(event, { runId?, step?, occasion?, childWorkflow?, count?, timeoutMs? })` | Tails **all** `logs/<wf>-<date>.jsonl` under the temp root and resolves once the P1.6 `event` has appeared `count` times. No sleeps. See sync-primitive section below. |
| `rt.holdAll(wf, stage)` | Mark every run of `wf` reaching a **gated** `stage` as held until `release`/cancel. (Call BEFORE enqueue.) |
| `rt.release(runId, stage)` | Release one held `(runId, stage)` → the run proceeds to `done`. |
| `rt.cancel(runId)` | **Real control-layer cancel** (see below). |
| `rt.children(parentRunId)` | Child runs (`parentRunId` on JSONL rows) across ALL row files — finds in-process delegated children whose workflow isn't a registered daemon. |
| `rt.dashboard()` | `{ row, groupAnchor, timeline }` over `snapshot-row.ts` — the REAL projection. |
| `rt.cleanup()` | `/stop` all daemons → await `runPromise`s → `closeStateDbForTests` → `rm` temp dir. Idempotent. Register with `t.onTestFinished`. |
| `rt.stubOcr(rawRecords, roster?)` | Seed PII-FREE synthetic **raw, form-shaped** OCR records (+ optional roster) the stub `runOcrOrchestrator` returns **VERBATIM** (the REAL `spec.matchRecord` runs on them). Build them via `rawOathRecordFromStub` (oath) or `rawEcRecordFromStub` (EC). Requires the `ocr` runtime option. Call BEFORE `enqueueOcr`. (P2.9 fleshed it; P2.10 made it FORM-AGNOSTIC — `_ocrPipelineOverride` no longer re-maps an oath struct.) |
| `rt.enqueueOcr({ fixturePath, originalName?, runId?, sessionId?, parentRunId? })` | Register a renderable PDF + enqueue an OCR run on the stub `"ocr"` daemon. Returns `{ sessionId, runId, usedFixture }`. Requires `ocr` opts. |
| `rt.approveOcr({ sessionId, runId, records, childWorkflows })` | Drive the REAL `buildOcrApproveHandler` fan-out, redirecting each child enqueue onto the matching gated daemon. **MULTI-TARGET** (P2.12): the approve route calls the override once per fan-out target (`approveTo.workflow` per-record, `approveDocumentTo.workflow` once-per-document); each `(workflow, inputs)` whose `workflow` is in `childWorkflows` (and registered) is routed onto that gated daemon, others stay pre-emit-only. Returns ALL claimed children `{ workflow, itemId, runId }[]` tagged by workflow. Back-compat: single-target `childWorkflow: string` still accepted (= a 1-element set; P2.9 + P2.10 use it). Requires `ocr` opts. |
| `rt.trackerDir` | The temp tracker root. |

The `ocr` runtime option (`createDelegationRuntime({ workflows, ocr: { formType } })`)
registers the thin test-only `"ocr"` workflow + daemon (`ocr-stub.ts`). The OCR
fan-out test pattern is documented in `tests/delegation/CLAUDE.md`.

`GatedWorkflowSpec` accepts optional `runtimePolicy` / `initialData` / `getId` /
`getName` / `deriveItemId` / `operatorSubject` / `label` so a gated stub can
mirror a real workflow's config faithfully (e.g. the oath-signature stub stamping
`emplId` + the real `alwaysBatchDelegatedMembers` policy so the projection matches
production; the P2.12 oath-upload stub mirroring `inputSubject:"pdf"` /
`code:"ou"` / `OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY` + stamping `pdfOriginalName`
for the file-kind ticket title and `signerItemIds` for the doc-fan-out assertion).

**OCR stub carries the operation `__traceId` onto its terminal re-stamp** (P2.12):
`makeStubOcrWorkflow` reads `findFrozenTraceId({ workflow:"ocr", runId })` and
includes it in the `ctx.updateData` re-stamp, so the kernel's auto-emitted
terminal `done` row keeps the orchestrator's branded id (`ou-…` for oath, `oc-…`
otherwise) instead of falling back to the workflow's own pre-emit code. Mirrors
production's `latestReviewData` (which carries `__traceId`). Without it, a raw
`timeline(...).at(-1).__traceId` assertion on the OCR root reads `oc-` even for an
oath operation.

### Gated stub workflows (`scenario-handler.ts`)

`makeGatedWorkflow(spec, coordinator)` registers a real `defineWorkflow` whose handler walks `stages` via `ctx.step`; at a **gated** stage it `await`s `coordinator.hold(runId, stage, ctx.signal)`. The held promise **rejects when `ctx.signal` aborts** — that's what turns a cancel into a `CancelledError` (the stepper's catch sees the abort and remaps it). `holdAll` is opt-in per stage; an ungated stage runs straight through (used for the in-process `delegateToAll` child). `cloneWithScript` + the `ScriptHooks`/beats vocabulary survive for scripted-beat scenarios but are not the daemon path.

### How `rt.cancel` drives the real path

`buildCancelRunningHandler(trackerDir)({ workflow, id, runId })` (the exact handler the dashboard cancel button reaches via `performWorkflowAction`) resolves the **running** task in SQLite at the temp root, flips it to `cancel_requested`, and enqueues a `cancel_task` worker command. The owning daemon's command poller picks it up → `requestCancel` → `runRegistry.cancel(runId)` aborts the per-run `AbortController` → the held stage's `ctx.signal` rejects → the daemon writes the `failed` + `step:"cancelled"` terminal row. **The task must be `running` when you cancel** — sync on `waitForEvent("step:start", { step, ... })` first so the child has been claimed.

### Delegation shapes supported

- **`parentRunId`-enqueue (independent children).** The star case (OCR→oath-signature). Each child is its own daemon run + `AbortController` → individually cancellable. Use `instances: N` to hold N concurrently. Proven by `harness-smoke` test 1.
- **In-process `delegateToAll`.** A parent whose `customHandler` calls `ctx.delegateToAll` over a **non-daemon-capable** child runs the children inside the parent worker; `delegation:children-spawned` fires on the parent's run log + `parentRunId` is stamped. Proven by `harness-smoke` test 2.

### Rough edges / gotchas

- **One daemon = one concurrent run** (serial claim loop). To hold K children of ONE workflow at once you MUST start K daemon instances (`instances: K`). This mirrors how a real workflow scales its pool.
- A `parentRunId`-only enqueue keeps the workflow's own archetype (`single`) + delegated scope; pass `renderAs:"batch"` for a `batch-member` archetype.
- `rt.cancel` requires the run to be `running`; cancelling a still-`queued` row would need `buildCancelQueuedHandler` (not yet exposed — add when a test needs it).
- The runtime calls `clear()` (registry) + `_resetRunRegistryForTests()` on construction — don't share one process's registry expectations across two live runtimes.

### Writing a delegation test

1. `const rt = await createDelegationRuntime({ workflows: [...] }); t.onTestFinished(() => rt.cleanup())`.
2. `rt.holdAll(wf, stage)` for any stage you want to park at, BEFORE enqueue.
3. `rt.enqueue(...)`, capture `runId`s.
4. `await rt.waitForEvent("step:start", { step, count })` to know runs reached the held stage.
5. Drive `rt.cancel(runId)` / `rt.release(runId, stage)` and `await rt.waitForEvent("run:terminal", { runId, occasion })`.
6. Assert with `rt.dashboard().row(...)` / `.groupAnchor(...)` (+ `rt.children(...)`).

## Sync primitive — structured log events (Phase 1 Task 6 + 7, landed)

`rt.waitForEvent` tails `logs/<workflow>-<date>.jsonl`
under the temp tracker root and awaits a named **`event`** (`StructuredLogEvent.event`,
a closed `LogEventName` set). The emitted set + each name's fire site and fields
are documented in `docs/engineering/structured-log-events.md`. Match on
`event` + `runId` (always present on run-scope log lines); `step` /
`childWorkflow` / `count` / `occasion` further qualify specific events.
The available names: `step:start`, `step:done`, `delegation:children-spawned`
(carries `childWorkflow` + `count`), `ocr:awaiting-approval`, `cancel:requested`,
`run:terminal` (branch on `occasion`: `completed`/`failed`/`cancelled`). These
are a stable contract — do not rename without updating every `waitForEvent`
call. `traceId` is NOT on these events (scope by `runId`).
