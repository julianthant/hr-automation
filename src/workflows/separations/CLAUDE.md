# Separations Workflow

Multi-system employee termination: extracts data from Kuali Build, searches Old & New Kronos for timesheets, creates the UCPath termination transaction, fetches Job Summary, and fills Kuali finalization fields.

> **Legacy — NOT kernel-migrated.** `workflow.ts` wires `withTrackedWorkflow` + `withLogContext` + `launchBrowser` directly; `index.ts` registers dashboard metadata via `defineDashboardMetadata`. Cross-system parallelism with shared browser lifecycles across batch items is the reason — the kernel's current `pool` mode launches one Session per worker, which would re-trigger Duo per doc.

## What this workflow does

Given one or more Kuali document IDs, for each doc: launch 4 tiled browsers (Kuali, Old Kronos, New Kronos, UCPath); auth all four (Duo serialized); extract separation data from Kuali; run a 4-way parallel fetch (Old Kronos timecard, New Kronos timecard, UCPath Job Summary, Kuali timekeeper name fill); resolve termination dates (Kronos always wins); create the UCPath termination transaction; write the transaction ID back to Kuali and save.

In batch mode, all Duo auths happen once upfront; the 4 browsers are then reused across every subsequent doc.

## Files

- `schema.ts` — `SeparationData` Zod schema + helpers (`computeTerminationEffDate`, `buildTerminationComments`, `mapReasonCode`, `getInitials`, `buildDateChangeComments`)
- `config.ts` — URLs, template IDs (`UC_VOL_TERM`, `UC_INVOL_TERM`), 2560x1440 tiling dimensions
- `workflow.ts` — Main orchestration. Wraps execution in `withTrackedWorkflow` with steps `launching → authenticating → kuali-extraction → kronos-search → ucpath-job-summary → ucpath-transaction → kuali-finalization`. Uses auth-ready promises so each browser starts work as soon as its own Duo clears. 4-way `Promise.allSettled` for parallel fetches
- `run.ts` — CLI entry (`runSeparation(docId, { keepOpen })`); batch mode pre-emits `pending` for all doc IDs and processes sequentially with shared browsers via `preAssignedRunId`
- `index.ts` — Barrel exports + `defineDashboardMetadata` call
- `explore-kronos.ts` — Dev script (selector discovery)
- `KRONOS-SELECTORS.md` — Historical selector notes from the Kronos mapping session

## Data Flow

```
CLI: docId(s) (Kuali document numbers)
  → Pre-emit pending for all doc IDs
  → Launch 4 tiled browsers once
  → Auth Kuali (Duo #1)
  → [Kuali nav + Old Kronos Duo #2 in parallel]
  → Auth chain continues in background (New Kronos Duo #3, UCPath Duo #4)
  → For each doc:
    → Extract separation data from Kuali form
    → Compute termination effective date (separation date + 1 day)
    → Parallel (4 windows): Old Kronos timecard + New Kronos timecard
                            + UCPath Job Summary + Kuali timekeeper fill
    → Resolve Kronos dates (Kronos always overrides Kuali)
    → Fill remaining Kuali fields (term date, dept, payroll)
    → UCPath termination transaction (Smart HR UC_VOL_TERM / UC_INVOL_TERM)
    → Kuali finalization (transaction number, save)
    → In batch: reset UCPath to Smart HR start page before next doc
```

## 4-browser tiling

```
Row 1: [ Kuali ] [ Old Kronos ]
Row 2: [ New Kronos ] [ UCPath ]
```

Screen 2560x1440. Windows positioned via Chromium `--window-position` / `--window-size` args.

## Gotchas

- **4 Duo authentications** — sequential (one at a time); never parallel. Auth-ready promises let each browser start its work as soon as its own Duo clears, while the user is still approving remaining Duos.
- **Kronos dates are ground truth** — `resolveKronosDates` always overrides Kuali dates when they differ (not just when later). Kronos is the authoritative last-day-worked source.
- **Termination effective date** = separation date + 1 day (computed, not from form).
- **Voluntary vs Involuntary** — `isVoluntaryTermination()` in `src/systems/kuali/navigate.ts`. "Never Started Employment" and "Graduated/No longer a Student" are involuntary; all others voluntary. Template is `UC_VOL_TERM` or `UC_INVOL_TERM` accordingly.
- **Reason-code mapping** — exact match → fuzzy match → fallback. VOL_TERM uses `"Resign - ..."` codes; INVOL_TERM uses codes like `"No Longer Student"`.
- **`computeKronosDateRange` ±1 month** — narrower windows missed timecards. `Date.setMonth()` overflow on 31st-day inputs slightly under-expands (Mar 31 − 1mo targets Feb 31 → Mar 3); harmless given the buffer. Pinned by `tests/unit/workflows/separations/schema.test.ts` — don't "fix" without considering test impact.
- **Transaction number extraction** — after clicking OK on the UCPath confirmation dialog, must renavigate via `navigateToSmartHR()` + `clickSmartHRTransactions()` to reach the transactions list, then extract the most recent transaction number. Cannot read it from the dialog itself.
- **Kuali date inputs occasionally ignore `fill()`** — see `src/systems/kuali/CLAUDE.md` for the retry-with-`type()` pattern.
- **`[NAV] framenavigated` listener** — Register during UCPath auth to detect login success; remove immediately after auth completes. Leaving it active fires on every subsequent PeopleSoft navigation.
- **Kronos log disambiguation** — every Kronos log message says `[Old Kronos]` or `[New Kronos]` so the dashboard doesn't show ambiguous lines.
- **`ensurePageHealthy()` before each phase** — SAML errors and session expiry happen silently. Each major phase calls this before proceeding (legacy-workflow pattern; the kernel's `Session.launch` retry handles fresh-auth failures declaratively).
- **Persistent UKG session** — `C:\Users\juzaw\ukg_session_sep` (one per worker).
- **Drill-in selector**: `PTS_CFG_CL_RSLT_PTS_DRILLIN$40$$IMG${rowIndex}` — row index must be exact.
- **Batch mode**: pre-emits `pending` for all doc IDs upfront; launches + auths browsers once; processes each doc sequentially reusing the same sessions.
- `explore-kronos.ts` is a dev tool, not a production workflow.

## Timing reference (rough, for regressions)

Fresh launch (first doc):
- Auth Kuali (#1): ~15s
- [Kuali nav ‖ Old Kronos Duo #2]: ~15s
- Extract (1s); auth chain continues in background (Duo #3, #4)
- Phase 1 (4-way parallel): ~60s (Old Kronos is the bottleneck; Job Summary + Kuali fill finish earlier)
- UCPath transaction: ~30s
- Kuali finalization: ~10s
- **Total: ~130s for first doc**

Batch mode (2nd+ docs, browsers already authed):
- Kuali nav + extract: ~24s
- Phase 1 parallel: ~60s
- UCPath transaction + Kuali finalization: ~30s
- **Total: ~115s per subsequent doc**

## Verified Selectors

Selectors used inside this workflow live in the per-system registries: `src/systems/kuali/selectors.ts`, `src/systems/old-kronos/selectors.ts`, `src/systems/new-kronos/selectors.ts`, `src/systems/ucpath/selectors.ts`. Workflow-specific selector discoveries:

- **INVOL_TERM reason codes** — verified via playwright-cli 2026-04-09. Full list documented in `schema.ts` REASON_CODE_MAP comment. "No Longer Student" confirmed for "Graduated/No longer a Student".

## Lessons Learned

- **2026-04-10: Kronos dates only overriding when later** — Original `resolveKronosDates` logic only updated Kuali dates when Kronos dates were later. Wrong: if Kronos shows an earlier last-day-worked (employee stopped working before Kuali's separation date), that should still override. Fix: Kronos always overrides when dates differ.
- **2026-04-10: `computeKronosDateRange` too narrow** — ±2 weeks missed timecards for employees whose last work was more than 2 weeks from the separation date. Expanded to ±1 month.
- **2026-04-10: UCPath transaction number not found after confirmation** — After clicking OK on the UCPath confirmation modal, the page navigates away from the transaction. Transaction number isn't readable from the modal text. Fix: renavigate to Smart HR Transactions list via `navigateToSmartHR()` + `clickSmartHRTransactions()` and find the most recent transaction.
- **2026-04-10: framenavigated listener left active** — The `[NAV]` listener registered during UCPath auth was never removed, causing noisy log entries on every subsequent PeopleSoft navigation. Fix: remove the listener after auth completes.
- **2026-04-10: Batch mode design** — For processing multiple separations, launching + authenticating 5 browsers per doc ID was too slow. Fix: batch mode launches browsers once, authenticates once, pre-emits `pending` for all doc IDs, then processes each sequentially reusing the same browser sessions. (Equivalent to what the kernel's `runWorkflowBatch` sequential mode offers declaratively — separations hasn't migrated yet.)
- **2026-04-10: Phase parallelization** — UCPath Job Summary and Kuali timekeeper fill were previously sequential (Phase 2), waiting for Kronos (Phase 1) to complete. Neither depends on Kronos results. Moved both into the same `Promise.allSettled` as Kronos searches. Saves ~30s per doc. Post-transaction UCPath reset also made batch-only.
- **2026-04-10: Interleaved auth + work via ready promises** — Previously all 4 Duo auths completed before any work started. Now each browser's work chains off an auth-ready promise so work starts immediately after its own Duo clears. Auth chain runs in background during Kuali extraction. Saves ~30s. (The kernel's `authChain: "interleaved"` is the same pattern, declared in one line — migrate-candidate for a future rework.)
