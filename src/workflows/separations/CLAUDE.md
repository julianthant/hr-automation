# Separations Workflow

Multi-system employee termination: extracts data from Kuali Build, searches Old & New Kronos for timesheets, creates the UCPath termination transaction, fetches Job Summary, and fills Kuali finalization fields.

**Kernel-based.** Declared via `defineWorkflow` in `workflow.ts` and executed through `src/core/runWorkflow` (single-doc) or `src/core/runWorkflowBatch` (multi-doc sequential mode). The kernel owns browser launch, auth-chain orchestration, per-doc tracker entries, SIGINT cleanup, and screenshot-on-failure. The public start path is dashboard input run (`InputRunPanel` → `/api/enqueue`), which enqueues one or more `{docId}` items to any alive separation daemon (or spawns one). `runSeparation` and `runSeparationBatch` are preserved for in-process use (tests, scripts).

## What this workflow does

Given one or more Kuali document IDs, for each doc: launch 4 tiled browsers (Kuali, Old Kronos, New Kronos, UCPath); **`authChain: "parallel-staggered"`** — every SSO form is filled in parallel, then submits are spaced (`staggerMs`, default 5s) so up to **four Duo prompts overlap** on the phone (approve in any order); extract separation data from Kuali; run a 4-way parallel fetch (Old Kronos timecard, New Kronos timecard, UCPath Job Summary, Kuali timekeeper name fill) via `ctx.parallel`; resolve termination dates (Kronos always wins); create the UCPath termination transaction; write the transaction ID back to Kuali and save.

In batch mode (`runWorkflowBatch`) or daemon mode, all four systems authenticate once per session startup; the browsers are reused for every doc, with `session.reset(id)` run between docs to restore a clean starting state.

## Selector intelligence

This workflow touches four systems: **kuali**, **ucpath**, **old-kronos**, **new-kronos**.

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"kuali date input"`, `"kronos timecard"`, `"ucpath job summary"`).
- Per-system lessons (read before re-mapping):
  - [`src/systems/kuali/LESSONS.md`](../../systems/kuali/LESSONS.md)
  - [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
  - [`src/systems/old-kronos/LESSONS.md`](../../systems/old-kronos/LESSONS.md)
  - [`src/systems/new-kronos/LESSONS.md`](../../systems/new-kronos/LESSONS.md)
- Per-system catalogs (auto-generated):
  - [`src/systems/kuali/SELECTORS.md`](../../systems/kuali/SELECTORS.md)
  - [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md)
  - [`src/systems/old-kronos/SELECTORS.md`](../../systems/old-kronos/SELECTORS.md)
  - [`src/systems/new-kronos/SELECTORS.md`](../../systems/new-kronos/SELECTORS.md)

## Parallel-staggered auth (kernel)

`authChain: "parallel-staggered"` replaces ad-hoc promise chains from the pre-kernel era:

- `prepareLogin` fills every system's SSO form **in parallel**.
- `submitLogin` runs on a stagger so Duo prompts from Kuali, Old Kronos, New Kronos, and UCPath **overlap** — the operator approves them in any order. Wall-clock auth is dominated by the slowest Duo plus stagger spacing, not four serial Duos.
- `ctx.page(id)` still awaits each system's ready promise, so Phase-1 `ctx.parallel` tasks start as soon as **that** system's Duo clears.

The old `interleaved` pattern (blocking first Duo + background chain) is **not** what ships today — see `defineWorkflow` in `workflow.ts`.

## 4-browser tiling

```
Row 1: [ Kuali ] [ Old Kronos ]
Row 2: [ New Kronos ] [ UCPath ]
```

Screen 2560x1440. `Session.launch` with `tiling: "auto"` detects actual screen dimensions via CDP on the first browser, then uses `computeTileLayout(i, 4)` + `Browser.setWindowBounds` to position each window.

## Gotchas

- **4 Duo authentications** — with parallel-staggered auth they **time-overlap** (not strictly one-at-a-time). Phase-1 work still starts per browser as soon as **that** browser's Duo completes.
- **Kronos dates are ground truth** — `resolveKronosDates` always overrides Kuali dates when they differ (not just when later). Kronos is the authoritative last-day-worked source.
- **Termination effective date** = separation date + 1 day (computed, not from form).
- **Voluntary vs Involuntary** — `isVoluntaryTermination()` in `src/systems/kuali/navigate.ts`. "Never Started Employment" and "Graduated/No longer a Student" are involuntary; all others voluntary. Template is `UC_VOL_TERM` or `UC_INVOL_TERM` accordingly.
- **Reason-code mapping** — exact match → fuzzy match → fallback. VOL_TERM uses `"Resign - ..."` codes; INVOL_TERM uses codes like `"No Longer Student"`.
- **`computeKronosDateRange` ±1 month** — narrower windows missed timecards. `Date.setMonth()` overflow on 31st-day inputs slightly under-expands (Mar 31 − 1mo targets Feb 31 → Mar 3); harmless given the buffer. Pinned by `tests/unit/workflows/separations/schema.test.ts` — don't "fix" without considering test impact.
- **Transaction number extraction** — after clicking OK on the UCPath confirmation dialog, must renavigate via `navigateToSmartHR()` + `clickSmartHRTransactions()` to reach the transactions list, then extract the most recent transaction number. Cannot read it from the dialog itself.
- **Kuali date inputs occasionally ignore `fill()`** — see `src/systems/kuali/CLAUDE.md` for the retry-with-`type()` pattern.
- **Kronos log disambiguation** — every Kronos log message says `[Old Kronos]` or `[New Kronos]` so the dashboard doesn't show ambiguous lines.
- **Persistent UKG session** — `~/ukg_session_sep` (set on `old-kronos` system's `sessionDir`).
- **Drill-in selector**: `PTS_CFG_CL_RSLT_PTS_DRILLIN$40$$IMG${rowIndex}` — row index must be exact.
- **Batch mode**: `runSeparationBatch(docIds)` wraps `runWorkflowBatch(separationsWorkflow, items, { deriveItemId, onPreEmitPending })` — emits `pending` per docId before auth begins so the dashboard populates the queue; `session.reset(id)` runs between docs for all 4 systems.

## Lessons Learned

- **Lesson maintenance rule:** Before adding a separations lesson, search this section and the four per-system `LESSONS.md` files. Merge stale auth/daemon/kernel notes into the current rule instead of appending another dated migration entry.
- **Duplicate prevention matches by EID/date, not name.** `findExistingTerminationTransaction(page, employeeId, effectiveDate)` and transaction-number readback key off Person ID plus effective date and termination text. Kuali/UCPath name variants are common enough that name matching created duplicate terminations; do not reintroduce name or template-code prefilters for duplicate checks.
- **No tracker-side step cache/idempotency for UCPath submits.** The removed `step-cache`, `idempotency`, `runSeparationRecover`, and `separation:recover` paths should stay removed. Retrying converges through the live Smart HR transaction list; Kuali extraction is re-scraped.
- **Transaction number must be persisted immediately.** Call `ctx.updateData({ transactionNumber })` at each UCPath success point: existing-transaction branch and fresh-submit branch. Do not rely on the handler's final update, because Kuali finalization can still fail after UCPath accepted the transaction.
- **2026-05-27: Submitted-without-number must capture lower UCPath readback.** If `clickSaveAndSubmit` reports success but no `T...` number, `runUcpathTransaction` now scrolls the reopened Smart HR iframe to the transaction readback area and captures `ucpath-transaction-submitted-missing-number` before aborting Kuali finalization. This preserves the visible `Transaction ID: T...` / approval-strip evidence for manual recovery.
- **Wrong Kuali EID should fail loudly.** Do not auto-correct through Workforce, Person Org Summary, or name search. The workflow should tell the operator to fix Kuali, then retry; EID/date duplicate protection prevents a second submit.
- **Current auth shape is `parallel-staggered`.** The old interleaved auth and hand-rolled promise chains are historical. `prepareLogin` runs in parallel, submit clicks are staggered so Duo prompts overlap, and `ctx.page(id)` awaits each system's readiness before work starts.
- **2026-05-25: Dashboard input run is the public start path.** `npm run separation` is retired; typed doc ID starts belong in `InputRunPanel` and `/api/enqueue`.
- **Daemon mode is queue-first.** Dashboard input runs validate inputs, enqueue SQLite tasks with pre-assigned run ids, pre-emit pending rows, wake alive daemons, then spawn a daemon when needed. JSONL queue files are audit only; SQLite is the authority.
- **Row archetype is single; batch config is only session reuse.** A one-doc dashboard enqueue must stamp `data.archetype="single"` so it renders as a flat row. Do not set separations to `archetype:"batch"` just because `runWorkflowBatch`/daemon mode can reuse the same four authenticated browser sessions for multiple docs.
- **Batch/session lifecycle is kernel-owned.** Sequential batch runs and daemon processing reuse the four browser sessions, run `session.reset(id)` between docs, and emit one workflow instance for the batch/session rather than one instance per doc. Do not call raw `launchBrowser`, `withTrackedWorkflow`, `withLogContext`, or old page-health wrappers from workflow code.
- **Kronos dates always win when present.** `resolveKronosDates` overrides Kuali dates even when Kronos is earlier. The date search window stays plus/minus one month; the `Date.setMonth()` overflow behavior is pinned by tests.
- **Phase-1 parallel work uses settled helpers.** Kuali timekeeper fill, UCPath Job Summary, Old Kronos, and New Kronos run in one `ctx.parallel` block. Reuse `settled.ts` (`logSettledRejection`, `unwrapSettled`) for non-fatal branch classification instead of repeating raw `PromiseSettledResult` checks.
- **Step timing logs are intentional.** Each `ctx.step(...)` body should log `START` via `log.debug` and `END took=Xms` via `log.step` on non-throw exits. Use `<empty>` for present-but-blank strings and `<none>` for null/undefined consistently.
- **Selector gotchas stay in system docs.** Workflow-specific reminders are limited to reason-code mapping and drill-in row index exactness here; PeopleSoft, Kuali date input, Old/New Kronos, and frame/navigation quirks belong in the relevant system `CLAUDE.md` / `LESSONS.md`.
