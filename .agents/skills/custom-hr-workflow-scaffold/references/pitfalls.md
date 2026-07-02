# Pitfalls — what NOT to do (and the fix)

Verified anti-patterns that have actually bitten this codebase. Each entry: **rule** → symptom → root cause → correct pattern. For the underlying models these violate, see `references/delegation-and-fanout.md` and `references/row-model.md` rather than re-deriving them here.

## Delegation & daemon coordination

### Never `delegateToAll(selfWorkflow, ...)` onto your own single-worker daemon and await it

**Symptom:** Workflow frozen at a step that delegates to its own workflow (e.g. oath-signature frozen at the OCR step); child batch members stuck `queued` forever.

**Root cause:** The daemon claim loop (`src/core/daemon/daemon.ts:421–643`) is strictly sequential — one `state.activeRun` at a time (claim one → await to completion → claim next). `delegateToAll(self, ...)` enqueues children onto the *same* daemon (`src/core/delegate.ts:423–555`, `dispatchToDaemonAndWait` → `ensureDaemonsAndEnqueue`) then blocks on `watchChildRuns` while `state.activeRun` is still set, holding the daemon's only worker. The loop can't claim the queued children because the parent never reaches the `finally` that clears `activeRun = null` (line 639). Permanent deadlock.

**Correct pattern:** Fan the independent work onto a **different** daemon via a hub/parent, then have the waiter join via cross-daemon `watchChildRuns` without holding its own worker (the model in `references/delegation-and-fanout.md` §2). Live example: OCR is the hub and fans both oath-signature signer rows and the oath-upload ticket row on approve; oath-upload's `wait-signatures` step calls `watchChildRuns({ workflow: "oath-signature", ... })` directly (`src/workflows/oath-upload/handler.ts:106–140`), so it never delegates onto — or blocks — its own claim loop.

```ts
// WRONG — blocks the daemon's only worker on its own queued children
await ctx.delegateToAll(oathSignatureWorkflow, signers)

// CORRECT — hub fans onto a DIFFERENT daemon; the waiter joins cross-daemon
await ctx.delegateToAll(oathSignatureWorkflow, signers)   // from the OCR hub
await ctx.delegateToAll(oathUploadWorkflow, [ticket])     // same different daemon
// oath-upload handler — no delegation, no hold on its own worker:
const outcomes = await watchChildRuns({
  workflow: "oath-signature",
  expectedItemIds: input.signerItemIds,
})
```

Further context: `src/tracker/delegation/watch-child-runs.ts:163–271` (polls task states via SQLite, never claims items itself), `src/workflows/oath-signature/CLAUDE.md:49–52`, `src/workflows/oath-upload/CLAUDE.md:22–32`.

## Self-emitting handlers

### A handler that self-emits rows must re-stamp `parentRunId` + `__traceId` + `queueRowKind` on every row

**Symptom:** A delegated OCR run's Approve button stays hidden in the dashboard; or a standalone OCR run's footer subtitle falls back to the literal `"OCR"` instead of the trace id.

**Root cause:** The OCR orchestrator (`src/workflows/ocr/orchestrator.ts`) emits its own rows via `writeTracker`, bypassing the kernel's row emission. The kernel only stamps `parentRunId`, `__traceId`, and `queueRowKind` on rows **it** emits via `ctx.step`; delegation passes `parentRunId` as a `ctx` option, never an input field, so a self-emitter drops it. Without `parentRunId` the delegated snapshot collapses to a standalone surface and the old `isDelegation` gate hid Approve. Without `queueRowKind`, `resolveQueueRowPresentation` returns `undefined` (`src/domain/queue-row-presentation.ts:58–62`) and the caller falls back to a hardcoded title.

**Correct pattern:** Prefer `ctx.step` so you inherit all three for free. If you must self-emit (the OCR orchestrator is the *only* current case), replicate the stamping:

- thread `ctx.parentRunId` (`src/core/kernel/ctx.ts:92,154`) through to the orchestrator as `input.parentRunId` (`src/workflows/ocr/workflow.ts:114–116`) and stamp it conditionally: `...(input.parentRunId ? { parentRunId: input.parentRunId } : {})` (`orchestrator.ts:279`);
- build `__traceId` **once** at function scope via `buildTraceId({ code: "oc", runId, at })` so it's identical across re-emits (`orchestrator.ts:185`, `src/domain/queue-trace-id.ts:40–42`);
- stamp `queueRowKind` to match the workflow's `inputSubject` (`"file"` for pdf) (`orchestrator.ts:271–272`).

Never hardcode `"OCR"` in a footer subtitle — the trace id rides the row and the presentation resolver builds the subtitle from it (see the subtitle rule in `references/row-model.md`). Gate Approve on `parentRunId` **OR** `hasApproveFanOut` so a standalone-with-fan-out OCR still shows it (`src/dashboard/components/ocr/OcrReviewPane.tsx:294`).

## Cross-process coordination

### Cross-process signals need a durable backstop keyed via `src/tracker/paths.ts` — never an in-memory event or a hand-spelled path

**Symptom:** A daemon-hosted OCR handler (oath-upload → oath-signature daemon → in-process OCR prep) stalls indefinitely at `step=ocr` when the operator approves from the dashboard SSE server (a *different* process).

**Root cause:** Two compounding bugs. (1) In-memory `emitApproved` cannot cross process boundaries, so the daemon never sees the dashboard's approval in-process. (2) The durable JSONL backstop in `subscribeToApproval` (`src/services/ocr/approval-signal.ts:284–292`) was reading from a stale **hand-spelled** flat path (`join(trackerDir, "ocr-<date>.jsonl")`) after the 2026-06-01 restructure moved rows to `.tracker/rows/`. The fallback polled a non-existent path forever.

**Correct pattern:** Reader code resolves canonical paths via `src/tracker/paths.ts` helpers (`rowFilePath` / `logFilePath` / `sessionFilePath` / `runtimeFilePath`), never `join(trackerDir, ...)`. `readLatestOcrApprovalState` uses `const path = rowFilePath("ocr", date, trackerDir)` (`approval-signal.ts:292`), which constructs `join(rowsDir(dir), "<workflow>-<date>.jsonl")` (`src/tracker/paths.ts:71–73`). In-memory `subscribeToApproval` / `emitApproved` is the same-process fast path only; the JSONL poll is the durable fallback for out-of-process and daemon-restart cases. After any restructure that moves a `.tracker/` subdir, grep **all** readers — not just `src/tracker/*.ts`, but `src/workflows/` and `src/domain/` too — and switch them to the helpers. Regression coverage: `tests/unit/services/ocr/approval-signal.test.ts:67–104` (out-of-process approve is picked up) and `:146–185` (a stale flat-path row is ignored). Ownership rule: `src/tracker/CLAUDE.md` — `paths.ts` owns all `.tracker/` construction.

## Row shape vs surface

### Control batching with `delegation` flags on `runtimePolicy`, never via `archetype`

**Symptom:** A delegated child with `archetype: "single"` renders flat/standalone in the queue, and a single-item input run also renders standalone — batching looks like it should be implicit in `archetype` but isn't.

**Root cause:** Batching is a **surface** decision applied at projection/enqueue time, while `archetype` is the invariant per-row **shape** (the shape-vs-scope distinction in `references/row-model.md`). The classifier `forcesBatchWhenDelegated` (`src/tracker/queue-surfaces.ts:72–80`) collapses a 1-member delegated set to a flat row **unless** `delegation.alwaysBatchDelegatedMembers` is set (`queue-surfaces.ts:214–228`). Separately, the dispatcher forces a batch `parentRunId` on a single-item input run only when `delegation.alwaysBatchInputRun` is set (`src/core/daemon/enqueue-dispatch.ts:206–216`). `data.archetype` stays `"single"` throughout.

**Correct pattern:** Declare `archetype: "single"` and stamp it on every row. Encode batching intent in `runtimePolicy.delegation`:

```ts
export const MY_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  delegation: {
    ...DEFAULT_WORKFLOW_RUNTIME_POLICY.delegation,
    alwaysBatchDelegatedMembers: true, // omit if a lone fanned-out member may render flat
    alwaysBatchInputRun: true,         // omit if a single-item direct input may stay single
  },
};

export const myWorkflow = defineWorkflow({
  name: "my-workflow",
  archetype: "single",                 // PER-ROW shape — not surface batching intent
  runtimePolicy: MY_WORKFLOW_RUNTIME_POLICY,
  // ...
});
```

oath-signature sets both flags (`src/workflows/oath-signature/workflow.ts:41–42`); person-lookup sets only `alwaysBatchDelegatedMembers` so direct one-person input runs stay single (`src/workflows/person-lookup/workflow.ts:69`). Policy interface: `src/domain/workflow-runtime/types.ts:68–100`.

## Trace identity

### Propagate the operation PREFIX, not the whole id — and stamp it on every fan-out path

**Symptom:** A fan-out's rows are hard to follow — either every row shows the *identical* trace id (you can't tell two members apart, so you fall back onto `batch#`/`#run`/EID), or some children share the operation's id and others mint their own unrelated one (a half-migration).

**Root cause:** Two mistakes. (1) Copying the root's **full** frozen id verbatim onto every descendant makes them indistinguishable — the right unit is *trace* (the `<code>-<HHMMSS>` prefix, shared) + *span* (each row's own `<runId4>` tail). (2) The `ctx` auto-forward (`makeCtx`'s `forwardRootTracePrefix`) only fires for children created through `ctx.delegateTo`/`delegateToAll`; a route that enqueues children **outside a `ctx`** (e.g. `src/tracker/dashboard/ocr/approve.ts`) gets nothing for free.

**Correct pattern:** Propagate the **prefix** via `rootTracePrefix` on `__runtimeOptions`; each row composes `<rootPrefix>-<ownRunId4>` with `buildTraceId({ …, rootPrefix })`. Keep `findFrozenTraceId` the FIRST fallback in **both** seed paths (`run-one-item.ts` / `run-workflow.ts` — edit them in lockstep) so a same-run re-emit reuses the frozen id. For any HTTP/non-`ctx` fan-out, read the root's frozen id (`findFrozenTraceId({ workflow, runId })`) and stamp `rootTracePrefix: tracePrefix(rootId)` on each enqueued input yourself. Brand the operation root with the form spec's `traceCode` when the operator's mental entry point differs from the physical root workflow (oath upload → OCR root branded `ou`). Model + invariants: `references/delegation-and-fanout.md` §6 + `references/row-model.md`.

## Item identity

### A delegation `deriveItemId` must key off the LOGICAL input and never return `""`

**Symptom:** Delegated child rows are **invisible in the queue panel** even though the workflow rail's amber badge and the control DB (`tasks`) show queued/running work; the dashboard logs spam `[jsonl] skipping invalid line N` for the child's `rows/` file; multiple distinct delegated runs collapse into a single row. The OCR **verify** fan-out hit exactly this (every `person-lookup` child got `item_id=""`).

**Root cause:** `delegateTo` / `delegateToAll` wrap **every** input with the kernel's `__runtimeOptions` channel (`rowShape` / `rootCode` / `rootTracePrefix`) via `withBatchMemberRuntimeOptions` + `withRootRuntimeOptions` (`src/core/delegate.ts:280,471`) *before* the id is derived. A custom `deriveItemId` that identity-matches the input — the `map.get(JSON.stringify(input)) ?? ""` pattern used by `verify.ts` / `force-research.ts` — keys its map on the *original* input but is then called with the *wrapped* one, so the JSON differs, the lookup misses, and `?? ""` yields an empty id. An empty id is poison: the tracker validator `isTrackerEntry` (`src/tracker/jsonl-io.ts:294–306`) **requires `id.length > 0`**, so the reader drops the row (invisible + the warning spam), and the id-keyed dedupe `dedupeLatestByIdWithCarriedEmplId` (`src/tracker/queue-row-count.ts:52`) collapses every empty-id run into one. Meanwhile the rail badge counts control-DB `queued` tasks directly (`readQueueDepth`), so it shows work the panel can't render — "items in queue but nothing in the panel."

**Correct pattern:** The kernel now derives the item id from the **logical** input — `ensureDaemonsAndEnqueue`'s `idFn` runs `splitPrefilled(input)` and calls `deriveItemId(cleaned)` (`src/core/daemon/client.ts:310`), and throws if the result is empty. So:

- Derive the id from a **stable field** of the input (`name`, `emplId`, a record index), not from object identity. An identity map keyed by `JSON.stringify(cleaned)` now hits, but a stable-field key can't drift at all.
- **Never return `""`.** An empty derived id throws at the enqueue boundary by design — fix the deriver, don't paper over the miss with `?? ""`.
- The cleaned input the deriver sees has **no** `__runtimeOptions` / `prefilledData`, so derive only from real workflow input fields (mirrors how `getId` reads `data`).

```ts
// WRONG — keyed on object identity; misses once the kernel wraps the input → ""
const byInput = new Map(inputs.map((inp, i) => [JSON.stringify(inp), itemIds[i]]))
deriveItemId: (inp) => byInput.get(JSON.stringify(inp)) ?? ""

// CORRECT — derive from a stable field of the logical input (never empty)
deriveItemId: (inp) => "emplId" in inp ? inp.emplId : normalizeName(inp.name)
```

Coverage: `src/workflows/person-lookup/schema.ts:93` (`derivePersonLookupItemId`), and the kernel strip in `src/core/daemon/client.ts` mirrors the HTTP path `src/core/daemon/enqueue-dispatch.ts:241–246`.

## Process hygiene

Small but load-bearing — these gate every commit.

- **Stage explicit file lists; never `git add -A`.** It risks staging PII-bearing test fixtures (e.g. `test.pdf`). `.gitignore` carries a prophylactic `/*.pdf` rule, but the rule is a backstop, not a license — use `git add src/ tests/ package.json`, not `-A`.
- **After editing any `src/systems/<sys>/selectors.ts`, run `npm run selectors:catalog` and commit the regenerated `SELECTORS.md`.** The drift-gate test (`tests/unit/scripts/selectors/catalog.test.ts`) fails the build otherwise. Map new selectors through `playwright-cli` / the `custom-hr-selector-map` skill first.
- **Drive ServiceNow Select2 v3 comboboxes via the registry helpers, not the offscreen focusser.** `specificallyChoice` / `categoryChoice` click the visible `a.select2-choice`, then `select2DropSearch` types, then `select2ResultOption` picks (`src/systems/servicenow/selectors.ts`, verified 2026-06-02; see `src/systems/servicenow/LESSONS.md`). Clicking the offscreen combobox focusser times out silently.
- **Use `src/tracker/paths.ts` helpers for every `.tracker/` path** (`rowFilePath`, `logFilePath`, `sessionFilePath`, `runtimeFilePath`, and the `*Dir` helpers). Never spell `.tracker/<subdir>` inline — `src/tracker/CLAUDE.md` forbids it, and the cross-process pitfall above is what hand-spelling causes.
- **Pre-commit gate:** `npm run typecheck && npm run test && npm run test:architecture && npm run lint`. All four must pass; lint failures are task failures.
