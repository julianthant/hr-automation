# Separations Workflow

Multi-system employee termination: extracts data from Kuali Build, reads the New Kronos timecard for the last physical punch + sick/holiday days, creates the UCPath termination transaction, fetches Job Summary, and fills Kuali finalization fields. **3 browsers — Kuali, New Kronos, UCPath** (Old Kronos was removed from separations 2026-06-18; the `old-kronos` system module still exists for `old-kronos-reports`).

**Kernel-based.** Declared via `defineWorkflow` in `workflow.ts` and executed through `src/core/runWorkflow` (single-doc) or `src/core/runWorkflowBatch` (multi-doc sequential mode). The kernel owns browser launch, auth-chain orchestration, per-doc tracker entries, SIGINT cleanup, and screenshot-on-failure. The public start path is dashboard input run (`InputRunPanel` → `/api/enqueue`), which enqueues one or more `{docId}` items to any alive separation daemon (or spawns one). `runSeparation` and `runSeparationBatch` are preserved for in-process use (tests, scripts).

## What this workflow does

Given one or more Kuali document IDs, for each doc: launch 3 tiled browsers (Kuali, New Kronos, UCPath); **`authChain: "parallel-staggered"`** — every SSO form is filled in parallel, then submits are spaced (`staggerMs`, default 5s) so up to **three Duo prompts overlap** on the phone (approve in any order); extract separation data from Kuali; run a 3-way parallel fetch (New Kronos timecard, UCPath Job Summary, Kuali timekeeper name fill) via `ctx.parallel`; reconcile dates (see "Date model" below); create the UCPath termination transaction; write the transaction ID back to Kuali and save.

In batch mode (`runWorkflowBatch`) or daemon mode, all three systems authenticate once per session startup; the browsers are reused for every doc, with `session.reset(id)` run between docs to restore a clean starting state.

## Date model (2026-06-18 rework — READ THIS)

The old "Kronos overrides both dates" model (`resolveKronosDates`) is **gone**. The reconciliation now is:

- **Last Day Worked** = New Kronos **last physical punch** (`getSeparationTimecardData().lastPunchDate`). It OVERRIDES the Kuali LDW when they differ (the timecard is ground truth for physical work). Falls back to `kualiData.lastDayWorked` when New Kronos returned no punch (`lastPunchDate === null`) OR kronos-search was skipped (edit-and-resume prefill / "Transactions only" preset).
- **Separation Date** = **Kuali's** `separationDate` — **AUTHORITATIVE, never overridden** by Kronos (it's the "last day actively employed", which may be later than LDW due to leave). It is **never written back** to the Kuali form.
- **Termination Effective Date** = Separation Date + 1 day (`computeTerminationEffDate`).
- **Sick / Holiday days** (`getSeparationTimecardData().sickDates` / `.holidayDates`) drive the **comment clause only** — they never change any date.

Only the LDW can be written back to Kuali (via `updateLastDayWorked`, gated on `ldwChanged`); `updateSeparationDate` is never called.

Comment wording (`buildTerminationComments`): `Termination eff <eff>. Last Day Worked <ldw>.` + optional sick clause (`Sick Leave on <d>.` / `Sick leave from <first> to <last>.`) + optional holiday clause (`Holiday Pay on <d>.` / `Holiday Pay from <first> to <last>.`) + ` Kuali form #<docId>.` (sick before holiday). The LDW-change audit note (`buildDateChangeComments`) is LDW-only now — no separation-date branch.

## Selector intelligence

This workflow touches three systems: **kuali**, **ucpath**, **new-kronos**.

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"kuali date input"`, `"kronos timecard"`, `"ucpath job summary"`).
- Per-system lessons (read before re-mapping):
  - [`src/systems/kuali/LESSONS.md`](../../systems/kuali/LESSONS.md)
  - [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
  - [`src/systems/new-kronos/LESSONS.md`](../../systems/new-kronos/LESSONS.md)
- Per-system catalogs (auto-generated):
  - [`src/systems/kuali/SELECTORS.md`](../../systems/kuali/SELECTORS.md)
  - [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md)
  - [`src/systems/new-kronos/SELECTORS.md`](../../systems/new-kronos/SELECTORS.md)

## Parallel-staggered auth (kernel)

`authChain: "parallel-staggered"` replaces ad-hoc promise chains from the pre-kernel era:

- `prepareLogin` fills every system's SSO form **in parallel**.
- `submitLogin` runs on a stagger so Duo prompts from Kuali, New Kronos, and UCPath **overlap** — the operator approves them in any order. Wall-clock auth is dominated by the slowest Duo plus stagger spacing, not three serial Duos.
- `ctx.page(id)` still awaits each system's ready promise, so Phase-1 `ctx.parallel` tasks start as soon as **that** system's Duo clears.

The old `interleaved` pattern (blocking first Duo + background chain) is **not** what ships today — see `defineWorkflow` in `workflow.ts`.

## 3-browser tiling

```
[ Kuali ] [ New Kronos ] [ UCPath ]
```

Screen 2560x1440. `Session.launch` with `tiling: "auto"` detects actual screen dimensions via CDP on the first browser, then uses `computeTileLayout(i, 3)` + `Browser.setWindowBounds` to position each window (tile count is derived from `systems.length`, so dropping Old Kronos re-tiles to 3 automatically).

## Gotchas

- **3 Duo authentications** — with parallel-staggered auth they **time-overlap** (not strictly one-at-a-time). Phase-1 work still starts per browser as soon as **that** browser's Duo completes.
- **Date reconciliation** — see "Date model" above. LDW = New Kronos last physical punch (overrides Kuali when it differs, falls back to Kuali when absent); Separation Date = Kuali (authoritative, never overridden, never written back); sick/holiday → comment clause only. The old `resolveKronosDates` "Kronos overrides both dates" model is removed.
- **Termination effective date** = separation date + 1 day (computed, not from form).
- **Voluntary vs Involuntary** — `isVoluntaryTermination()` in `src/systems/kuali/navigate.ts`. "Never Started Employment" and "Graduated/No longer a Student" are involuntary; all others voluntary. Template is `UC_VOL_TERM` or `UC_INVOL_TERM` accordingly.
- **Reason-code mapping** — exact match → fuzzy match → fallback. VOL_TERM uses `"Resign - ..."` codes; INVOL_TERM uses codes like `"No Longer Student"`.
- **`computeKronosDateRange` ±1 month** — narrower windows missed timecards. `Date.setMonth()` overflow on 31st-day inputs slightly under-expands (Mar 31 − 1mo targets Feb 31 → Mar 3); harmless given the buffer. Pinned by `tests/unit/workflows/separations/schema.test.ts` — don't "fix" without considering test impact. The range is still computed from `computeKronosDateRange(kualiData.lastDayWorked, kualiData.separationDate)` and passed into kronos-search so the New Kronos timecard view selects the right window.
- **Transaction number extraction** — after clicking OK on the UCPath confirmation dialog, must renavigate via `navigateToSmartHR()` + `clickSmartHRTransactions()` to reach the transactions list, then extract the most recent transaction number. Cannot read it from the dialog itself.
- **Kuali date inputs occasionally ignore `fill()`** — see `src/systems/kuali/CLAUDE.md` for the retry-with-`type()` pattern.
- **Kronos log disambiguation** — every Kronos log message says `[New Kronos]` so the dashboard doesn't show ambiguous lines.
- **UCPath Last Date Worked field NOT set (deferred).** The reconciled `lastDayWorked` flows only through `finalComments` → `fillComments`. The UCPath "Last Date Worked" field + "Override Last Date Worked" checkbox are **not** set — those selectors don't exist yet and need a live UCPath mapping. Tracked by `// TODO(separations): explicitly set UCPath Last Date Worked …` near the ucpath-transaction step in `workflow.ts`.
- **Batch mode**: `runSeparationBatch(docIds)` wraps `runWorkflowBatch(separationsWorkflow, items, { deriveItemId, onPreEmitPending })` — emits `pending` per docId before auth begins so the dashboard populates the queue; `session.reset(id)` runs between docs for all 3 systems.

## Dry-run boundary

`SeparationInputSchema` carries an optional `dryRun` flag (mirrors onboarding /
oath-signature / emergency-contact). Unlike onboarding — which has a SINGLE
irreversible write (the UCPath Smart HR submit) at its last step — separations
has **two** committing mutations: the UCPath Smart HR submit
(`clickSaveAndSubmit`, inside `ucpath-transaction`) and the Kuali finalization
save (`runKualiFinalize`, inside `kuali-finalization`). So the dry-run terminal
sits **earlier**, right after date reconciliation and **before
the first Kuali write**: it `skipStep`s `ucpath-job-summary` /
`ucpath-transaction` / `kuali-finalization`, captures a
`separations-dry-run-before-submit` screenshot, stamps `status: "Dry Run
Complete"` + `dryRun: true` (plus the reconciled read data for the detail panel),
logs `DRY RUN: reached UCPath Smart HR transaction … submit + Kuali finalization
skipped`, and returns succeeded / `done`.

What still runs in dry-run: 3-system auth (**3 Duos**), Kuali extraction, the
3-way New-Kronos/Job-Summary parallel fetch, and date reconciliation — the entire
READ path. The **one** residual write is the timekeeper-name fill bundled into
`kronos-search`'s parallel block; it touches the **unsubmitted** Kuali draft and
commits nothing (the doc is never finalized), the same way onboarding's
search-first I-9 create runs in its dry-run. The load-bearing no-mutation proofs
are: **no UCPath transaction exists** (`clickSaveAndSubmit` never called → no
`transactionNumber`, no UCPath-submitted screenshot) and **the Kuali document is
never finalized** (`runKualiFinalize` skipped). Live mode (no `dryRun`) is
unchanged.

Dashboard exposure: separations is a dashboard **input-run** start surface
(`INPUT_RUN_REGISTRY`, `supportsDryRun: true`) — typed doc id(s), comma-separated
→ sequential batch — with a per-page-load dry-run toggle in the input panel's
run-settings gear that folds `dryRun: true` onto each enqueued docId.

## Lessons Learned

- **Lesson maintenance rule:** Before adding a separations lesson, search this section and the three per-system `LESSONS.md` files (kuali, new-kronos, ucpath). Merge stale auth/daemon/kernel notes into the current rule instead of appending another dated migration entry.
- **2026-06-18: New-Kronos-only rework — Old Kronos removed, sick/holiday-aware dates + comments.** Separations dropped the `old-kronos` system entirely (still used by `old-kronos-reports`), going from 4 browsers to **3** (Kuali, New Kronos, UCPath). The date model was replaced: `resolveKronosDates` (Kronos overrides BOTH dates) is **deleted**. Now **Last Day Worked = New Kronos last physical punch** (`getSeparationTimecardData().lastPunchDate`, overrides Kuali LDW when different, falls back to Kuali LDW when null / kronos skipped); **Separation Date = Kuali's, authoritative — never overridden, never written back**; **Termination Eff = Sep + 1**. New `getSeparationTimecardData` also returns `sickDates` / `holidayDates` which drive a **comment clause only** (never a date): `buildTerminationComments(termEff, ldw, docId, { sickDates, holidayDates })` emits `Termination eff <e>. Last Day Worked <l>.` + `Sick Leave on <d>.`/`Sick leave from <f> to <l>.` + `Holiday Pay on <d>.`/`Holiday Pay from <f> to <l>.` + ` Kuali form #<id>.` (sick before holiday; note lowercase "eff", title-case "Last Day Worked" — the old "Termination EFF"/"Last day worked" wording is retired). `buildDateChangeComments` is now LDW-only (Sep never changes → no separation-date branch). `updateSeparationDate` is no longer called from the handler. The UCPath "Last Date Worked" field + Override checkbox are **deferred** (selectors don't exist — see the TODO in `workflow.ts` near the ucpath-transaction step). Pinned by `schema.test.ts` (3 worked examples: Lydia Li sick-range #3949, Kou Nathan single-holiday #4016, normal #4131) + `dry-run.test.ts` (3 systems, LDW=punch override, Sep=Kuali, no `foundInOldKronos`).
- **2026-06-17: Audit screenshots are now PER-SYSTEM with the right capture mode — never a blind all-systems `fullPage`.** Every separations audit `ctx.screenshot` sets `systems:[...]` (was omitted → one event mixed all 4 tiled browsers) and picks the capture mode that fits the surface: **Kuali** finalization → `systems:['kuali'], slices:3` (the whole tall form as 3 vertical slices — a single `fullPage` shot was an unreadable narrow ribbon on the quarter-screen tiled viewport); **UCPath** submitted/confirmation → `systems:['ucpath'], slices:2` (the PeopleSoft form lives in a nested iframe; `captureFullPage`/widen already probe child frames for width), other UCPath shots just add `systems:['ucpath']`; **New Kronos** → after `scrollNewKronosTimecardToDate` (now `block:'center'`), `systems:['new-kronos'], centerSelector:'.ui-grid-viewport'` — a VIEWPORT (not `fullPage`) shot centered on the last physical punch (the new LDW). (Old Kronos was removed from separations 2026-06-18, so there is no longer an old-kronos audit shot in this workflow — the `scrollOldKronosTimecardToDate`/`iframe`-centered capture lives only with `old-kronos-reports` now.) **Why viewport, not fullPage, for Kronos:** the timecard is a VIRTUAL-SCROLL grid — `fullPage` only captures the rows currently rendered in the DOM, missing off-screen data; centering the target row and shooting the viewport is the only way to get the chosen date with real neighbours. `centerSelector` on a full-viewport container (`.ui-grid-viewport`) is a near no-op scroll whose real job is selecting the viewport-only capture path while the row stays centered from the system scroll helper. The New Kronos shot is best-effort (fires even if scroll/lookup missed). Capture-mode mechanics live in `src/core/CLAUDE.md` (Audit Screenshots). **NEEDS LIVE RE-VERIFY:** the Kuali 3-slice / UCPath 2-slice content coverage and the Kronos date-centering can only be confirmed against the real SSO+Duo forms in the live phase; the slice/center mechanics are verified locally on a synthetic page.
- **2026-06-17: Short/invalid Kuali EIDs are resolved by delegating to person-lookup by NAME (`resolveSeparationEid`).** Operators sometimes type a short/malformed EID into Kuali (e.g. `"1061029"` = 7 digits; a valid UCPath EID is `^10\d{6}$` per `isUcpathEmployeeId`). A short EID makes the UCPath lookup find nothing → no transaction number, so the run died far downstream with an opaque error. `resolveSeparationEid` (exported from `workflow.ts`) runs in the handler right after `kualiData` is established by **either** path (the `kuali-extraction` step OR the edit-and-resume prefilled bypass) and **before** any consumer of `kualiData.eid` (the Kronos date math + `runKronosSearch`). Guard logic: (1) EID passes `isUcpathEmployeeId` → returned unchanged, no delegation, no latency; (2) EID is provably invalid → `ctx.delegateTo(personLookupWorkflow, { name: kualiData.employeeName })` resolves the correct full EID (`result.data.emplId`), then the handler rewrites `kualiData = { ...kualiData, eid }` **and** `ctx.updateData({ eid })` so the corrected value flows to every downstream step + the final snapshot / detail panel; (3) person-lookup returns no valid EID (failed run, OR a `done` run whose `emplId` still fails `isUcpathEmployeeId`) → **fails loud**, throwing `Short/invalid EID "…" for "…" — person-lookup returned no EID. Fix the EID in the Kuali form and retry.` — never continues silently with the bad EID. Delegate by NAME, never the bad EID (the name input path has no EID-format constraint). **Latency cost:** person-lookup is daemon-capable, so the delegation routes through a person-lookup daemon that authenticates UCPath + CRM independently (a separate Duo/auth pass) — the accepted tradeoff for recovering an otherwise-doomed run. Integration shape is **inline handler logic + a delegated child row**, NOT a new pipeline step: the 5-step `steps` tuple is unchanged (a new step would shift indices + the dashboard StepPipeline + the registry), and the person-lookup child surfaces on its own via `parentRunId` (a delegated row under the separation). The kuali-extraction schema (`schema.ts` `eid: ^\d{5,}$`) is left LENIENT on purpose — tightening it would make extraction throw before the guard can run. Pinned by `tests/unit/workflows/separations/resolve-eid.test.ts` (delegate-by-name + corrected EID, valid-EID no-op, fail-loud on no/invalid lookup).
- **2026-06-17: Dry-run halts before BOTH irreversible writes (UCPath submit + Kuali finalization).** `dryRun` (optional schema flag) terminates the handler right after date reconciliation, before any Kuali form write — skipping `ucpath-job-summary` / `ucpath-transaction` / `kuali-finalization` and stamping `status: "Dry Run Complete"`. Placed earlier than onboarding's guard because separations commits in two steps, not one. MUST stay declared in the Zod schema — an unknown `dryRun` is stripped by Zod, which would silently re-enable a real termination. Added so the workflow can be e2e-tested live (read path + 3 Duos) through the dashboard input run without creating a UCPath transaction or finalizing the Kuali doc. Pinned by `tests/unit/workflows/separations/dry-run.test.ts`.
- **Duplicate prevention matches by EID/date, not name.** `findExistingTerminationTransaction(page, employeeId, effectiveDate)` and transaction-number readback key off Person ID plus effective date and termination text. Kuali/UCPath name variants are common enough that name matching created duplicate terminations; do not reintroduce name or template-code prefilters for duplicate checks.
- **No tracker-side step cache/idempotency for UCPath submits.** The removed `step-cache`, `idempotency`, `runSeparationRecover`, and `separation:recover` paths should stay removed. Retrying converges through the live Smart HR transaction list; Kuali extraction is re-scraped.
- **Transaction number must be persisted immediately.** Call `ctx.updateData({ transactionNumber })` at each UCPath success point: existing-transaction branch and fresh-submit branch. Do not rely on the handler's final update, because Kuali finalization can still fail after UCPath accepted the transaction.
- **2026-05-27: Submitted-without-number must capture lower UCPath readback.** If `clickSaveAndSubmit` reports success but no `T...` number, `runUcpathTransaction` now scrolls the reopened Smart HR iframe to the transaction readback area and captures `ucpath-transaction-submitted-missing-number` before aborting Kuali finalization. This preserves the visible `Transaction ID: T...` / approval-strip evidence for manual recovery.
- **Wrong Kuali EID should fail loudly — EXCEPT a provably-invalid EID, which is resolved by name via person-lookup (scoped exception, 2026-06-17).** Do not auto-correct an 8-digit-but-semantically-wrong EID through Workforce / Person Org Summary / name search — that case still fails loud and stays the operator's problem to fix in Kuali (EID/date duplicate protection prevents a second submit). The ONE carve-out: an EID that is *provably* invalid — fails `isUcpathEmployeeId` (not `^10\d{6}$`, e.g. a 7-digit `"1061029"`) — is corrected by delegating to **person-lookup by NAME**, because such an EID can never match a real UCPath person (the lookup would find nothing → no transaction). If person-lookup still returns nothing, the run FAILS LOUD with a fix-the-Kuali-form error. See the 2026-06-17 lesson below.
- **Current auth shape is `parallel-staggered`.** The old interleaved auth and hand-rolled promise chains are historical. `prepareLogin` runs in parallel, submit clicks are staggered so Duo prompts overlap, and `ctx.page(id)` awaits each system's readiness before work starts.
- **2026-05-25: Dashboard input run is the public start path.** `npm run separation` is retired; typed doc ID starts belong in `InputRunPanel` and `/api/enqueue`.
- **Daemon mode is queue-first.** Dashboard input runs validate inputs, enqueue SQLite tasks with pre-assigned run ids, pre-emit pending rows, wake alive daemons, then spawn a daemon when needed. JSONL queue files are audit only; SQLite is the authority.
- **Row archetype is single; batch config is only session reuse.** A one-doc dashboard enqueue must stamp `data.archetype="single"` so it renders as a flat row. Do not set separations to `archetype:"batch"` just because `runWorkflowBatch`/daemon mode can reuse the same four authenticated browser sessions for multiple docs.
- **Batch/session lifecycle is kernel-owned.** Sequential batch runs and daemon processing reuse the three browser sessions, run `session.reset(id)` between docs, and emit one workflow instance for the batch/session rather than one instance per doc. Do not call raw `launchBrowser`, `withTrackedWorkflow`, `withLogContext`, or old page-health wrappers from workflow code.
- **New Kronos last punch sets the LDW; Kuali Separation Date is authoritative (2026-06-18 rework — supersedes the old "Kronos dates always win").** LDW = New Kronos last physical punch (overrides Kuali when different, falls back to Kuali LDW when absent); Separation Date is never overridden or written back. The date search window stays plus/minus one month; the `Date.setMonth()` overflow behavior is pinned by tests.
- **Phase-1 parallel work uses settled helpers.** Kuali timekeeper fill, UCPath Job Summary, and New Kronos run in one `ctx.parallel` block (3-way now — Old Kronos removed). Reuse `settled.ts` (`logSettledRejection`, `unwrapSettled`) for non-fatal branch classification instead of repeating raw `PromiseSettledResult` checks.
- **Step timing logs are intentional.** Each `ctx.step(...)` body should log `START` via `log.debug` and `END took=Xms` via `log.step` on non-throw exits. Use `<empty>` for present-but-blank strings and `<none>` for null/undefined consistently.
- **Selector gotchas stay in system docs.** Workflow-specific reminders are limited to reason-code mapping and drill-in row index exactness here; PeopleSoft, Kuali date input, Old/New Kronos, and frame/navigation quirks belong in the relevant system `CLAUDE.md` / `LESSONS.md`.
