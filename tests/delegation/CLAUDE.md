# Tier-1 delegation tests

Deterministic tests proving the **dashboard projection stays correct under
delegation, concurrency, and cancellation** — driven through the **real daemon**
against a temp tracker root (no live browser, no real `.tracker/`). They run in
`npm test` automatically (the main glob picks them up; no separate pool).

The harness foundation lives in `_runtime/` (`createDelegationRuntime` +
projection tooling `snapshot-row.ts`). Full harness API + gotchas:
`_runtime/CLAUDE.md`.

## Tests

| File | Shape |
|------|-------|
| `harness-smoke.test.ts` | The linchpin: 3-child `parentRunId` fan-out, cancel one mid-hold, siblings unaffected, projection asserts, `.tracker/` untouched. Reference pattern for all delegation tests. |
| `ocr-oath-signature.test.ts` | **P2.9 star test** — OCR → oath-signature `approveTo` fan-out through the real daemon, under hold/cancel/release. |

## OCR fan-out test pattern (P2.9)

The OCR → downstream `approveTo` fan-out is exercised through three harness
seams, all gated on the `ocr` runtime option (`createDelegationRuntime({
workflows, ocr: { formType } })`):

1. **`rt.stubOcr(records, roster?)`** — seed PII-FREE synthetic records (fake
   names + UCPath-shaped `10######` EIDs) the stub `runOcrOrchestrator` returns.
   The thin test-only `"ocr"` workflow + daemon (`_runtime/ocr-stub.ts`) drives
   the REAL orchestrator with stubbed LLM/roster/eid-lookup (`_ocrPipelineOverride`
   / `_loadRosterOverride` / `_enqueueEidLookupOverride` / `_watchChildRunsOverride`
   / `_disableSqliteDependencies`) — no browser, no LLM, no SQLite deps. When
   `roster` is omitted, one roster row per record is derived (EID short-circuit →
   `matched`). Call BEFORE `enqueueOcr`.
2. **`rt.enqueueOcr({ fixturePath, originalName? })`** — register a renderable
   PDF (prefers the real fixture e.g. `tests/data/multiple-oath.pdf`; falls back
   to a synthetic one-pager if it can't render headlessly — records come from the
   override regardless) and enqueue the OCR run. Returns `{ sessionId, runId,
   usedFixture }`. Sync on `rt.waitForEvent("ocr:awaiting-approval", { runId })`.
3. **`rt.approveOcr({ sessionId, runId, records, childWorkflow })`** — drive the
   REAL `buildOcrApproveHandler`: the real `approveTo.deriveInput/deriveItemId/
   canFanOut`, `childParentRunId = parentRunId ?? ocrRunId`, trace-prefix
   propagation, and terminal OCR row all run, with the child enqueue redirected
   onto `childWorkflow`'s gated daemon via `rt.enqueue(..., { renderAs: "batch" })`.
   Resolves with the enqueued child runs (`{ itemId, runId }[]`) once the route's
   BACKGROUND dispatch IIFE finishes (the helper polls the captured handle, no
   sleeps). A fan-out target with no daemon in the runtime (e.g. `oath-upload`'s
   once-per-document ticket when only `oath-signature` is under test) gets its
   pending row pre-emitted but is not claimed.

**Make the child stub faithful.** The gated `oath-signature` stub mirrors the
REAL config so the projection matches production: `inputSubject:"eid"`,
`code:"os"`, `archetype:"single"`, the real `OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY`
(its `delegation.alwaysBatchDelegatedMembers:true` → delegated members render as
a batch surface even singly), and a spec `initialData` stamping `emplId` + an
`eid`-kind `operatorSubject` (so the person-kind footer subtitle resolves to the
EID). `makeGatedWorkflow`'s `GatedWorkflowSpec` was extended to accept
`runtimePolicy` / `initialData` / `getId` / `getName` / `deriveItemId` /
`operatorSubject` / `label` for exactly this faithfulness.

### Subtitle truth (assert the real projection, not a guess)

- OCR parent (file kind) → title = PDF filename, subtitle = `<traceId>` (scrubbed).
- oath-signature child **batch-member** row (person kind): the EID shows on the
  title line, so the per-row footer subtitle resolves to the **EID** (real value,
  NOT scrubbed) via `resolveQueueRowPresentation` (`preferTraceIdSubtitle` is OFF
  for the per-row path). The **group anchor** subtitle is `<traceId>` (the anchor
  path uses `preferTraceIdSubtitle: true`).
- The OCR kernel terminal `done` row would otherwise be sparse (no
  `pdfOriginalName`) and clobber the rich approve-route row in latest-wins
  dedupe; the stub handler re-stamps the captured `onReviewData` payload + `mode:
  "prepare"` on the success path so the terminal row keeps the file-kind title —
  mirroring the real `ocrKernelHandler`.

## Not yet asserted here

- **Retry-after-cancel** — P2.9 does NOT assert it; `tests/integration/
  retry-original-input.test.ts` is kept until a Tier-1 test owns it.
