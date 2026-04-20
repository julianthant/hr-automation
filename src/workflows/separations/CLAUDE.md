# Separations Workflow

Multi-system employee termination: extracts data from Kuali Build, searches Old & New Kronos for timesheets, creates the UCPath termination transaction, fetches Job Summary, and fills Kuali finalization fields.

**Kernel-based.** Declared via `defineWorkflow` in `workflow.ts` and executed through `src/core/runWorkflow` (single-doc) or `src/core/runWorkflowBatch` (multi-doc sequential mode). The kernel owns browser launch, auth-chain orchestration, per-doc tracker entries, SIGINT cleanup, and screenshot-on-failure. The CLI adapters `runSeparation` and `runSeparationBatch` handle dry-run (which bypasses the kernel entirely — no browser) and forward real runs to the kernel.

## What this workflow does

Given one or more Kuali document IDs, for each doc: launch 4 tiled browsers (Kuali, Old Kronos, New Kronos, UCPath); auth via interleaved Duo chain (#1 blocking, #2..#4 chained in background); extract separation data from Kuali; run a 4-way parallel fetch (Old Kronos timecard, New Kronos timecard, UCPath Job Summary, Kuali timekeeper name fill) via `ctx.parallel`; resolve termination dates (Kronos always wins); create the UCPath termination transaction; write the transaction ID back to Kuali and save.

In batch mode (`runWorkflowBatch`), all Duo auths happen once upfront; the 4 browsers are then reused for every subsequent doc, with `session.reset(id)` run between docs to restore a clean starting state.

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

## Files

- `schema.ts` — `SeparationData` Zod schema + helpers (`computeTerminationEffDate`, `buildTerminationComments`, `mapReasonCode`, `getInitials`, `buildDateChangeComments`, `resolveKronosDates`, `computeKronosDateRange`)
- `config.ts` — URLs, template IDs (`UC_VOL_TERM`, `UC_INVOL_TERM`), 2560x1440 tiling dimensions
- `workflow.ts` — Kernel definition (`separationsWorkflow`) + CLI adapters (`runSeparation`, `runSeparationBatch`). Dry-run branch bypasses the kernel (no browser launch; prints pipeline preview)
- `index.ts` — Barrel exports (no `defineDashboardMetadata` — `defineWorkflow` self-registers)
- `explore-kronos.ts` — Dev script (selector discovery)
- `KRONOS-SELECTORS.md` — Historical selector notes from the Kronos mapping session

## Kernel Config

| Field | Value | Why |
|-------|-------|-----|
| `systems` | `[kuali, old-kronos, new-kronos, ucpath]` — each wraps login fn to throw on failure | 4 independent auth systems, each with its own Duo prompt |
| `steps` | `["kuali-extraction", "kronos-search", "ucpath-job-summary", "ucpath-transaction", "kuali-finalization"] as const` | Kernel auto-prepends `auth:kuali`, `auth:old-kronos`, `auth:new-kronos`, `auth:ucpath` (see root `CLAUDE.md` — `authSteps` config field) |
| `schema` | `SeparationInputSchema = z.object({ docId })` — only docId from CLI | Kuali extraction fills in the rest via `ctx.updateData` |
| `authChain` | `"interleaved"` | Kuali auth blocking, then Old Kronos / New Kronos / UCPath chained in background via `.catch(() => {}).then(...)`. Each `ctx.page(id)` call awaits that system's ready promise, so Phase-1 tasks start as soon as their own Duo clears |
| `tiling` | `"auto"` | Kernel tiles 4 browsers via `computeTileLayout(i, 4)`. CDP sets window bounds after launch using actual screen dimensions |
| `batch` | `{ mode: "sequential", betweenItems: ["reset-browsers"] }` | Multi-doc runs reuse the same 4 browsers; kernel calls `session.reset(id)` between docs (each system has a `resetUrl`) |
| `detailFields` | `[{ name, Employee }, { eid, EID }, { docId, Doc ID }, { terminationType, Term Type }, { separationDate, Sep Date }, { transactionNumber, Txn # }]` | Dashboard detail panel; all 6 fields populated via `ctx.updateData(...)` during workflow execution |

## Data Flow

```
CLI: npm run separation <docId> [<docId2> ...]
  → runSeparation (single) / runSeparationBatch (multi) — CLI adapters
    → if --dry-run: previewSeparationPipeline(docId) — prints 7-step plan, exits 0 (no browser)
    → else (single): runWorkflow(separationsWorkflow, { docId })
    → else (batch): runWorkflowBatch(separationsWorkflow, items, {
        deriveItemId: (item) => item.docId,
        onPreEmitPending: (item, runId) => trackEvent({ pending }),
      })
      → Kernel Session.launch: 4 browsers, interleaved auth chain (Duo ×4)
      → For each doc (sequential, browsers reused):
        - Kernel emits `pending` via onPreEmitPending (batch mode)
        - withTrackedWorkflow wraps the handler, reuses pre-emitted runId
        - Handler: markStep("launching") + markStep("authenticating")
                   (kernel already handled browser launch + auth)
        - Step "kuali-extraction" → openActionList + clickDocument + extractSeparationData
                                  + updateData({ name, eid })
        - Step "kronos-search" → ctx.parallel({ oldK, newK, jobSummary, kualiTimekeeper })
          - Each task: await ctx.page(system) (blocks on that Duo), then do work
          - Returns PromiseSettledResult per key — handler reads fulfilled values,
            logs rejected reasons; Kronos failure → Kuali dates win
        - Resolve Kronos dates (Kronos overrides Kuali when they differ)
        - Update Kuali lastDayWorked + separationDate if resolved dates changed
        - Step "ucpath-job-summary" → fill Kuali term eff date + dept/payroll
        - Step "ucpath-transaction" → Smart HR UC_VOL_TERM or UC_INVOL_TERM
          - In batch mode: nav UCPath back to Smart HR after transaction
        - Step "kuali-finalization" → fill txn number + date-change comments + save
        - Final updateData (transaction number, dept info, Kronos found flags)
      → Between docs: session.reset(id) for each system (resetUrl navigation)
      → Batch result: succeeded / failed / errors
```

## Interleaved auth pattern

The kernel's `authChain: "interleaved"` subsumes the old inline pattern:

```typescript
// Legacy (workflow.ts pre-migration)
let oldKronosReady = (async () => { await loginToUKG(...); })();
await Promise.allSettled([kualiNav(), oldKronosReady]);
newKronosReady = oldKronosReady.catch(() => {}).then(async () => { await loginToNewKronos(...); });
ucpathReady = newKronosReady.catch(() => {}).then(async () => { await loginToUCPath(...); });
ucpathReady.catch(() => {});
```

Becomes the one-line declaration:

```typescript
// Kernel (workflow.ts post-migration)
authChain: "interleaved",
```

`Session.launch` does the blocking Kuali auth, then chains Duos #2..#4 in background with per-step `.catch(() => {})` between each. `ctx.page(id)` awaits the matching ready promise, so `ctx.parallel({ oldK, newK, ... })` inside Phase 1 implicitly blocks on the correct Duo per task.

## 4-browser tiling

```
Row 1: [ Kuali ] [ Old Kronos ]
Row 2: [ New Kronos ] [ UCPath ]
```

Screen 2560x1440. `Session.launch` with `tiling: "auto"` detects actual screen dimensions via CDP on the first browser, then uses `computeTileLayout(i, 4)` + `Browser.setWindowBounds` to position each window.

## Gotchas

- **4 Duo authentications** — sequential (one at a time); never parallel. The kernel's interleaved chain lets each browser start its work as soon as its own Duo clears, while the user is still approving remaining Duos.
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
- **Dry-run bypasses the kernel** — no browser launch, no Kuali extraction; prints a 7-step pipeline preview and exits 0. Useful for CI smoke tests with fake docIds.
- **Batch mode**: `runSeparationBatch(docIds)` wraps `runWorkflowBatch(separationsWorkflow, items, { deriveItemId, onPreEmitPending })` — emits `pending` per docId before auth begins so the dashboard populates the queue; `session.reset(id)` runs between docs for all 4 systems.
- `explore-kronos.ts` is a dev tool, not a production workflow.

## Timing reference (rough, for regressions)

Fresh launch (first doc):
- Session.launch: 4 browsers + Duo #1 (Kuali, blocking): ~15s
- Auth chain continues in background (Duo #2..#4): ~45s total; Phase-1 tasks start as each auth clears
- kuali-extraction: ~8s
- kronos-search (4-way parallel): ~60s (Old Kronos is the bottleneck; Job Summary + Kuali timekeeper finish earlier)
- ucpath-job-summary: ~5s (Kuali dept/payroll fill)
- ucpath-transaction: ~30s
- kuali-finalization: ~10s
- **Total: ~130s for first doc**

Batch mode (2nd+ docs, browsers already authed):
- Between-docs reset: ~5s
- kuali-extraction: ~24s
- kronos-search: ~60s (same bottleneck)
- ucpath-job-summary + ucpath-transaction + kuali-finalization: ~45s
- **Total: ~115s per subsequent doc**

## Verified Selectors

Selectors used inside this workflow live in the per-system registries: `src/systems/kuali/selectors.ts`, `src/systems/old-kronos/selectors.ts`, `src/systems/new-kronos/selectors.ts`, `src/systems/ucpath/selectors.ts`. Workflow-specific selector discoveries:

- **INVOL_TERM reason codes** — verified via playwright-cli 2026-04-09. Full list documented in `schema.ts` REASON_CODE_MAP comment. "No Longer Student" confirmed for "Graduated/No longer a Student".

## Lessons Learned

- **2026-04-17: Migrated to the kernel.** `runSeparation` + `runSeparationBatch` are CLI adapters over `runWorkflow` / `runWorkflowBatch`. `authChain: "interleaved"` replaces the hand-rolled `oldKronosReady.catch(...).then(...)` promise chain — `Session.launch` does the blocking Duo #1 + chains Duos #2..#4 in background with per-step `.catch(() => {})` so one bad auth doesn't block siblings. `ctx.page(id)` awaits each system's ready promise, so `ctx.parallel({ oldK, newK, jobSummary, kualiTimekeeper })` inside Phase 1 implicitly blocks on the correct Duo per task. Batch mode via `runWorkflowBatch` sequential — browsers reused across docs, `session.reset(id)` runs between docs for all 4 systems (each has a `resetUrl`). Dry-run bypasses the kernel entirely (no browser, no Kuali extraction — prints a 7-step plan and exits 0). `defineDashboardMetadata` dropped from `index.ts` (the kernel self-registers via `defineWorkflow`). `run.ts` deleted (dead code — `src/cli.ts separation <ids...>` owns batch entry via `runSeparationBatch`). `SessionWindows` / `BrowserWindow` types dropped (the kernel owns the session). Don't reintroduce raw `launchBrowser` / `withTrackedWorkflow` / `withLogContext` / `ensurePageHealthy` calls in the workflow or CLI adapters — those live in `src/core/` now. **Live-run pending user verification** — 4 simultaneous Duo approvals can't be exercised this session; only dry-runs + tests validate the migration.
- **2026-04-10: Kronos dates only overriding when later** — Original `resolveKronosDates` logic only updated Kuali dates when Kronos dates were later. Wrong: if Kronos shows an earlier last-day-worked (employee stopped working before Kuali's separation date), that should still override. Fix: Kronos always overrides when dates differ.
- **2026-04-10: `computeKronosDateRange` too narrow** — ±2 weeks missed timecards for employees whose last work was more than 2 weeks from the separation date. Expanded to ±1 month.
- **2026-04-10: UCPath transaction number not found after confirmation** — After clicking OK on the UCPath confirmation modal, the page navigates away from the transaction. Transaction number isn't readable from the modal text. Fix: renavigate to Smart HR Transactions list via `navigateToSmartHR()` + `clickSmartHRTransactions()` and find the most recent transaction.
- **2026-04-10: framenavigated listener left active** — The `[NAV]` listener registered during UCPath auth was never removed, causing noisy log entries on every subsequent PeopleSoft navigation. Fix: remove the listener after auth completes.
- **2026-04-10: Batch mode design** — For processing multiple separations, launching + authenticating 4 browsers per doc ID was too slow. Fix: batch mode launches browsers once, authenticates once, processes each sequentially reusing the same browser sessions. The kernel's `runWorkflowBatch` sequential mode now does this declaratively via `batch: { mode: "sequential", betweenItems: ["reset-browsers"] }`.
- **2026-04-10: Phase parallelization** — UCPath Job Summary and Kuali timekeeper fill were previously sequential (Phase 2), waiting for Kronos (Phase 1) to complete. Neither depends on Kronos results. Moved all four into the same parallel block (`ctx.parallel` post-migration). Saves ~30s per doc.
- **2026-04-10: Interleaved auth + work via ready promises** — Previously all 4 Duo auths completed before any work started. Now each browser's work chains off an auth-ready promise so work starts immediately after its own Duo clears. The kernel's `authChain: "interleaved"` is the declarative equivalent; post-migration this is a one-line declaration on `defineWorkflow`.
- **2026-04-20: Per-system auth steps + screenshot framework + txn # readback.** Kernel now auto-prepends `auth:<id>` step names and emits step events per system via `makeAuthObserver`. Umbrella `launching`/`authenticating` steps dropped from the declared tuple. Added form screenshots at UCPath-submit and Kuali-save sites via `ctx.screenshot({ kind: "form", label })`. `fillTransactionResults` now uses `fillWithVerify` (readback + `type()` retry) — run 2 silently dropped the transaction number because Kuali ignores `.fill()` on certain inputs the same way it does for date fields. Detail panel extended to 6 fields: Employee / EID / Doc ID / Term Type / Sep Date / Txn #.
