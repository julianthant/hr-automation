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
| `ocr-emergency-contact.test.ts` | **P2.10** — OCR → emergency-contact `approveTo` fan-out, same hold/cancel/release shape for a DIFFERENT form type (nested `EmergencyContactRecord` input, default delegation policy, `oc-` trace code). |
| `ocr-verify-lookup.test.ts` | **P2.11** — OCR `verify` → person-lookup + i9-lookup **`enrichRecords`** fan-out (NO approve fan-out; verify is read-only). Asserts the full enrichment projection + a cancel-mid-enrichment invariant. See "verify enrichment fan-out shape" below. |

## OCR fan-out test pattern (P2.9)

The OCR → downstream `approveTo` fan-out is exercised through three harness
seams, all gated on the `ocr` runtime option (`createDelegationRuntime({
workflows, ocr: { formType } })`):

1. **`rt.stubOcr(rawRecords, roster?)`** — seed PII-FREE synthetic **raw OCR
   records** (fake names + UCPath-shaped `10######` EIDs) the stub
   `runOcrOrchestrator` returns **VERBATIM**. The thin test-only `"ocr"` workflow +
   daemon (`_runtime/ocr-stub.ts`) drives the REAL orchestrator with stubbed
   LLM/roster/eid-lookup (`_ocrPipelineOverride` / `_loadRosterOverride` /
   `_enqueueEidLookupOverride` / `_watchChildRunsOverride` /
   `_disableSqliteDependencies`) — no browser, no LLM, no SQLite deps. **The stub
   is FORM-AGNOSTIC** (P2.10): `_ocrPipelineOverride` returns the seeded records
   untouched and the REAL `spec.matchRecord` runs on them, so the test supplies
   form-shaped raw records — oath-shaped via `rawOathRecordFromStub`, EC-shaped
   via `rawEcRecordFromStub` (`PermissiveRecordSchema` shape: `employee.{name,
   employeeId}` + nested `emergencyContact`). When `roster` is omitted, one roster
   row per record is derived via the form-agnostic `rawRecordEid`/`rawRecordName`
   extractors (EID short-circuit → `matched`). Call BEFORE `enqueueOcr`.
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

The gated `emergency-contact` stub (P2.10) mirrors EC: `inputSubject:"name"`,
`code:"ec"`, `archetype:"batch"`, the real
`EMERGENCY_CONTACT_WORKFLOW_RUNTIME_POLICY` (**default** delegation policy — NO
`alwaysBatchDelegatedMembers`). Its `initialData`/`getId`/`getName`/`deriveItemId`
read the **nested** `EmergencyContactRecord` (`employee.employeeId` /
`employee.name`), stamping flat `emplId`/`employeeName` so the title resolves to
the employee name and the subtitle to the EID. Because EC fans out **3** members
under one parentRunId, they still group into a `batch` anchor via the count-≥2
path in `buildTrackerQueueSurfaces` — `alwaysBatchDelegatedMembers` only matters
for the lone-member case. EC has no `traceCode`, so the OCR root + every child
keep the default `oc-…` prefix (oath brands `ou-` via `spec.traceCode`).

**Approve payloads:** build the selected/approved records via
`approvedOathRecordsFromStub` (oath: `selected:true` + `matchSource:"form-eid"`)
or `approvedEcRecordsFromStub` (EC: `selected:true` + `matchSource:"form"`, nested
`employee`/`emergencyContact` satisfying `approveTo.deriveInput`; EC has no
`approveTo.canFanOut`, so every selected record fans out).

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

## verify enrichment fan-out shape (P2.11)

`verify` is a **read-only** OCR form — NO `approveTo`/`approveDocumentTo`, so
there is **no approve fan-out** (unlike P2.9/P2.10). Its delegation lives in the
form spec's **`enrichRecords` hook**, which the orchestrator awaits ONCE before
the awaiting-approval snapshot. The hook `delegateToAllImpl({ child:
personLookupWorkflow / i9LookupWorkflow, fireAndForget: true, renderAs: "flat",
rootTracePrefix })` to:

1. **person-lookup** — every record with a `name` (itemId `ocr-verify-<runId>-r<idx>`).
2. **i9-lookup** — oath records with `officerSigned !== true` and a parseable name
   (itemId `ocr-verify-i9-<runId>-r<idx>`).

The OCR root brands `vf` (`spec.traceCode`); every child shares the `vf-…` prefix.

**Key mechanism finding (drove the test design): the children are
DAEMON-DISPATCHED, not in-process.** `delegateToAllImpl` checks
`isDaemonCapable(child)` FIRST — and both person-lookup and i9-lookup are in
`WORKFLOW_LOADERS`, so it routes through `dispatchToDaemonAndWait` →
`ensureDaemonsAndEnqueue` (NOT the in-process `runWorkflow` path; the
"`fireAndForget` always in-process" rule is `delegateToImpl`-singular only). The
OCR worker then waits on the children via the REAL `watchChildRuns` (SQLite task
states). So the test registers **gated stub daemons under the names
`person-lookup` + `i9-lookup`** (mirroring the real `code`/`inputSubject`/
`archetype`/runtime-policy), exactly the P2.9/P2.10 gated-stub pattern, so the
verify fan-out's `ensureDaemonsAndEnqueue` **reuses** these alive daemons rather
than spawning real `tsx` daemon subprocesses (which crash headless). The
children run their stub handlers to `done` → `watchChildRuns` resolves → verify
reaches `awaiting-approval`. Faithful, no `vi.mock`.

**Harness gotcha — short `idleTimeoutMs` is REQUIRED for this shape.**
`ensureDaemonsAndEnqueue` wakes the alive daemon at its Step-5 wake BEFORE it
commits the SQLite tasks at Step 6, so the first `/wake` misses (the daemon
ticks, claims nothing, sleeps). With no second wake, the daemon only re-polls on
its keepalive (`idleTimeoutMs`). Use a **short** `idleTimeoutMs` (e.g. 1000ms) so
the child tasks claim promptly. (P2.9/P2.10 don't hit this — `rt.enqueue` /
`rt.approveOcr` wake AFTER enqueue.) The OCR daemon is `processing` during
enrichment, so a short idle window doesn't spin it down mid-run.

**Asserted invariants:** OCR verify parent `preview` + file-kind title +
`<traceId>` subtitle + `vf-…` trace, reaches awaiting-approval (status stays
`running` — no approve fan-out means the operator never approves, so it never
goes terminal `done` on its own); 3 person-lookup + 1 i9-lookup children under
`parentRunId === ocrRunId`, natural `single` archetype, `person` kind, name
titles, `<traceId>` subtitle (no EID on paper); group anchors `batch`/3 and
`batch`/1 (both policies set `alwaysBatchDelegatedMembers`); `rt.children` ==
exactly 4, no orphans/dupes; itemIds match `ocr-verify-…`/`ocr-verify-i9-…`.
**Cancel:** cancelling the OCR **parent** mid-enrichment (synced on a held
person-lookup `searching` stage) drives it to terminal cancelled (status
`failed` + `Cancelled` + `step:"cancelled"`, keeps the `preview` archetype +
file-kind title) without hanging in `watchChildRuns`. The daemon-dispatched
children are independent daemon runs, so a parent cancel does NOT propagate to
them (they continue on their own daemons) — the test asserts only the PARENT
invariant. **No log-audit allowlist change was needed** — the happy-path
children complete cleanly and the cancel emits stdout (`! Cancelled by user`),
not stderr.

## Not yet asserted here

- **Retry-after-cancel** — P2.9 does NOT assert it; `tests/integration/
  retry-original-input.test.ts` is kept until a Tier-1 test owns it.
