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
| `ocr-oath-upload.test.ts` | **P2.12** — OCR (oath form) → oath-upload **`approveDocumentTo`** once-per-document fan-out. Approving an oath OCR run fans out to TWO daemons: 1 oath-signature signer row (`approveTo`) + 1 oath-upload TICKET row (`approveDocumentTo`), both under the OCR run, sharing the `ou-` trace prefix. Asserts the doc fan-out projection (ticket row file-kind title + `signerItemIds` input) + cancel-the-ticket-leaves-signer invariant. Drove the multi-target `rt.approveOcr` generalization. See "approveDocumentTo doc fan-out shape" below. |

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
3. **`rt.approveOcr({ sessionId, runId, records, childWorkflows })`** — drive the
   REAL `buildOcrApproveHandler`: the real `approveTo.deriveInput/deriveItemId/
   canFanOut`, the once-per-document `approveDocumentTo` fan-out,
   `childParentRunId = parentRunId ?? ocrRunId`, trace-prefix propagation, and
   terminal OCR row all run, with each child enqueue redirected onto the matching
   gated daemon (any workflow in `childWorkflows`) via `rt.enqueue(..., {
   renderAs: "batch" })`. Resolves with ALL enqueued child runs — each tagged by
   its `workflow` (`{ workflow, itemId, runId }[]`) — once the route's BACKGROUND
   dispatch IIFE finishes (the helper polls the captured handle, no sleeps).
   **`rt.approveOcr` is MULTI-TARGET** (generalized in P2.12): the approve route
   calls the override once per fan-out target workflow (`approveTo.workflow` with
   N inputs; `approveDocumentTo.workflow` with 1 input), and the override routes
   each `(workflow, inputs)` whose `workflow` is in `childWorkflows` (and is
   registered) onto that gated daemon. A target NOT requested/registered keeps
   the pre-emit-only behavior (its pending row is emitted but never claimed).
   Back-compat: a single-target `childWorkflow: string` is still accepted (P2.9 +
   P2.10 use it) and treated as a 1-element set. The completion poll waits for
   exactly the count of claimed targets named in the synchronous `fannedOut`
   response.

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

## approveDocumentTo doc fan-out shape (P2.12)

The oath form spec declares BOTH approve targets, so approving ONE oath OCR run
fans out to TWO different daemons:

- **`approveTo`** (per-record) → **oath-signature** signer rows (itemId
  `ocr-oath-${ocrRunId}-r${index}`) — the P2.9 path.
- **`approveDocumentTo`** (once-per-document) → ONE **oath-upload** TICKET row
  (itemId `ocr-oath-upload-${ocrRunId}`). Its `OathUploadInput` carries
  `signerItemIds` = the signer itemIds actually enqueued (so the ticket can wait
  on exactly those rows), plus `pdfFileId`, `pdfOriginalName`, `mode:"full"`,
  `rosterMode:"download"`. The doc fan-out runs through the real route's
  `enqueueDocFanOut`, which calls the SAME `ensureDaemonsAndEnqueueOverride` with
  the single doc input.

`single-oath.pdf` → 1 signer record → 1 signer row + 1 ticket row, both parented
under the OCR run, all sharing the `ou-…` trace prefix.

**The gated oath-upload stub mirrors the REAL config** (`inputSubject:"pdf"` →
FILE kind, `code:"ou"`, `archetype:"single"`, the real
`OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY`). Its `initialData`/`getName`/`getId`
surface `pdfOriginalName` (file-kind title) + `sessionId`, and stamp
`signerItemIds` (JSON) so the test can assert the doc fan-out handed the ticket
the signer itemIds. Gated at `wait-signatures` (the real first step where the
ticket parks waiting on the signers) so the test can hold/cancel/release it.

**P2.12 asserts the PROJECTION of the doc fan-out — NOT the real ticket-filing
logic.** A gated stub files no ServiceNow ticket; the real `oathUploadHandler` /
ticket-reuse / `wait-signatures` logic stays covered by the KEPT
`oath-upload-smoke.test.ts` + `oath-upload-extended.test.ts` integration tests
(permanent — NOT superseded by this projection test).

**Asserted invariants:** OCR parent `preview` + file-kind title + `<traceId>`
subtitle + `ou-…` trace + terminal `done`; signer row real archetype
`batch-member` (oath-signature `alwaysBatchDelegatedMembers` → a lone delegated
signer renders as a 1-member batch surface), `parentRunId === ocrRunId`,
person/eid title+subtitle, `ou-` prefix, itemId `ocr-oath-${ocrRunId}-r0`;
**ticket row** file-kind (title = PDF filename, subtitle = `<traceId>`),
`parentRunId === ocrRunId`, `ou-` prefix, itemId `ocr-oath-upload-${ocrRunId}`,
input `signerItemIds === [signer itemId]` (the core P2.12 assertion); OCR root +
signer + ticket share the same `ou-<HHMMSS>` prefix (root trace-id propagation);
`rt.children(ocrRunId)` finds the signer + ticket (filtering the OCR
orchestrator's synthetic `person-lookup` eid-lookup outcome row — same harness
noise P2.9/P2.10 filter); cancel the held ticket → terminal `failed`/step
`cancelled`, the signer UNAFFECTED (released to `done` after). **Retry-after-
cancel SKIPPED** (see "Not yet asserted here").

**Stub fidelity note (carried `__traceId`):** the OCR stub now carries the
operation's frozen `__traceId` onto its terminal re-stamp
(`findFrozenTraceId({ workflow:"ocr", runId })`). The orchestrator stamps the id
(`ou-…` for oath, `oc-…` otherwise) on its rows AFTER `onReviewData` captured the
review payload, so without this the kernel's auto-emitted terminal `done` row
fell back to the workflow's own pre-emit code (`oc-`) and clobbered the operation
prefix on the LATEST OCR row — making a raw `at(-1).__traceId` assertion read
`oc-` even for oath. Production's `latestReviewData` carries `__traceId` for the
same reason; the stub now mirrors it. (Harmless for EC/verify — the frozen id IS
`oc-`/`vf-` there.)

## Phase 2 complete — coverage map (P2.9–P2.12)

Every OCR-fan-out shape now has a Tier-1 projection test through the real daemon:

| Test | Workflow / shape | Fan-out mechanism |
|------|------------------|-------------------|
| `ocr-oath-signature.test.ts` (P2.9) | oath-signature, `single`→`batch-member` | `approveTo` (per-record) |
| `ocr-emergency-contact.test.ts` (P2.10) | emergency-contact, `batch`/`batch-member` | `approveTo` (per-record), default delegation policy, `oc-` trace |
| `ocr-verify-lookup.test.ts` (P2.11) | person-lookup + i9-lookup, `single` | `enrichRecords` (read-only verify; no approve) |
| `ocr-oath-upload.test.ts` (P2.12) | oath-upload, `single` ticket | `approveDocumentTo` (once-per-document) |

The multi-target `rt.approveOcr` (P2.12) is the shared seam covering BOTH
`approveTo` + `approveDocumentTo` in one approve call.

## Not yet asserted here

- **Retry-after-cancel** — P2.9–P2.12 do NOT assert it; `tests/integration/
  retry-original-input.test.ts` is kept until a Tier-1 test owns it.
