# EID Lookup Workflow

Searches UCPath Person Organizational Summary for employees by name, filters for SDCMP business unit and Housing/Dining/Hospitality departments, with optional CRM cross-verification.

**Kernel-based.** Two `defineWorkflow` definitions in `workflow.ts`:
- `eidLookupWorkflow` (no-CRM): 1 system (UCPath), 2 steps (`ucpath-auth` → `searching`)
- `eidLookupCrmWorkflow` (CRM-on): 2 systems (UCPath + CRM, sequential auth), 4 steps (`ucpath-auth` → `searching` → `crm-auth` → `cross-verification`)

Both share one searching/cross-verify body. Inside `ctx.step("searching", ...)` the handler calls `runWorkerPool` from `src/utils/worker-pool.ts` to fan out the name list across N tabs in a single shared `BrowserContext` (page-per-worker pattern — one Duo auth, multiple parallel searches). Per-name Excel tracker writes go through an async-mutex; per-name JSONL rows are NOT emitted (one workflow run per CLI invocation — see "Acceptable regression" below).

## Files

- `schema.ts` — Zod `EidLookupInputSchema` (`{ names: string[], workers: number }`); CRM-on alias `EidLookupCrmInputSchema` is the same shape.
- `search.ts` — Multi-strategy name search (`searchByName`, `parseNameInput`): "Last, First Middle" → tries full → first → middle, drills into SDCMP results, filters by HDH keywords. Kernel-agnostic.
- `crm-search.ts` — CRM cross-verification (`searchCrmByName`, `datesWithinDays`): last/first name search, extracts PPS ID + UCPath EID + hire date + dept, ±7 day date matching helper. Kernel-agnostic.
- `tracker.ts` — Excel writer (`updateEidTracker`, `updateEidTrackerNotFound`) → `eid-lookup-tracker.xlsx`. Preserved per workflows CLAUDE.md grandfather clause.
- `workflow.ts` — Kernel definitions (`eidLookupWorkflow`, `eidLookupCrmWorkflow`) + CLI adapter (`runEidLookup`). Dry-run branch bypasses the kernel (no browser; logs the planned name list + CRM mode + worker count).
- `index.ts` — Barrel exports.

## Kernel Config

| Field | `eidLookupWorkflow` | `eidLookupCrmWorkflow` |
|-------|---------------------|------------------------|
| `systems` | `[ucpath]` | `[ucpath, crm]` |
| `steps` | `["ucpath-auth", "searching"]` | `["ucpath-auth", "searching", "crm-auth", "cross-verification"]` |
| `schema` | `EidLookupInputSchema` | `EidLookupCrmInputSchema` |
| `authChain` | `"sequential"` | `"sequential"` |
| `tiling` | `"single"` | `"auto"` |
| `detailFields` | `[]` | `[]` |

## Data Flow

```
CLI: tsx src/cli.ts eid-lookup "Last, First Middle" [...] [--no-crm] [--workers N] [--dry-run]
  → runEidLookup (CLI adapter)
    → if --dry-run: log planned name list + CRM mode, exit 0 (no browser)
    → if --no-crm: runWorkflow(eidLookupWorkflow, { names, workers })
    → else: runWorkflow(eidLookupCrmWorkflow, { names, workers })
      → Kernel Session.launch: 1-2 browsers, sequential auth (Duo ×1 or ×2)
      → Handler markStep("ucpath-auth"); await ctx.page("ucpath")
      → (CRM mode) markStep("crm-auth"); await ctx.page("crm")
      → ctx.step("searching", async () => {
          runWorkerPool({
            items: names,
            workerCount,
            setup: workerId => workerId === 1 ? authPage : context.newPage(),
            process: async (name, workerPage) => {
              const result = await searchByName(workerPage, name)
              for (const r of result.sdcmpResults) await lockedUpdateEidTracker(name, r)
            },
          })
          ctx.updateData({ totalNames, foundCount, missingCount })
        })
      → (CRM mode) ctx.step("cross-verification", async () => {
          for (const name of names) await crossVerifyOne(crmPage, name, results)
        })
      → Console summary table
```

## Worker pool semantics

- N workers (`--workers`, default `min(names.length, 4)`) share one `BrowserContext`. Worker 1 reuses the auth page; workers 2..N each call `context.newPage()` for a fresh tab.
- Queue-based distribution via `runWorkerPool` from `src/utils/worker-pool.ts`. Each worker pulls names from a shared queue until empty.
- Per-name failures (search throws) are caught in the `process` callback, logged, and push a `failed` LookupResult. The queue continues. The kernel sees one workflow run with one transition — no per-name dashboard rows.
- Concurrent Excel writes are serialized via an async `Mutex` around `updateEidTracker` / `updateEidTrackerNotFound`. JSONL writes (handled by the kernel) need no coordination — `appendFileSync` is atomic per-line.

## Acceptable regression: per-name JSONL rows

Pre-kernel, every name was wrapped in its own `withTrackedWorkflow` so the dashboard showed one row per name. The kernel migration ships ONE row per CLI invocation (e.g. "lookup 20 names" → 1 dashboard row, not 20). Per-name results still land in Excel + console logs.

Restoring per-name rows requires `runWorkflowBatch` with a `mode: "pool"` variant that respects shared-context semantics (currently the pool launches one browser per worker — too heavy for eid-lookup's "1 Duo, N tabs" model). Tracked under deviation #3 in the migration plan; out of scope for this migration.

## Dashboard integration

- Workflow name: `eid-lookup`
- Step config (declared on `defineWorkflow({ steps })`): `["ucpath-auth", "searching", "crm-auth", "cross-verification"]` — no-CRM mode only fires the first two; CRM mode fires all four.
- Detail fields (declared on `defineWorkflow({ detailFields })`): `searchName`, `emplId`, `started`, `elapsed`. (`name` for the dashboard's `getName` resolver comes from `ctx.updateData` indirectly — currently empty after migration since per-name updates went away. Acceptable for this migration; the row's ID is the kernel-derived UUID + the rolled-up summary stats.)

## Name Search Strategy

1. Try full name: `lastName, firstName middleName`
2. If no SDCMP results: try `lastName, firstName` (drop middle)
3. If still nothing: try `lastName, middleName` (middle as first)

## Gotchas

- PeopleSoft search results table ID: `tdgbrPTS_CFG_CL_STD_RSL$0`
- Valid data rows must have exactly 9 cells with numeric Empl ID (5+ digits) in first cell
- Drill-in selector: `PTS_CFG_CL_RSLT_PTS_DRILLIN$40$$IMG${rowIndex}` — row index must be exact
- Assignment table scan: finds first row with 12+ cells where cell[3] matches business unit pattern (4-5 uppercase chars + optional digit) and cell[6] is department description
- "View All" button may need re-clicking after drill-in if results are paginated (rowIndex > 10)
- CRM search uses different strategy: last name first, then first name
- CRM date matching uses ±7 day tolerance for hire date comparison
- Parallel mode: shared auth context (one Duo), multiple tabs, queue-based distribution
- Browsers kept open for inspection (no automatic close)

## Verified Selectors

*(Add selectors here after each playwright-cli mapping session — include date and page)*

## Lessons Learned

- **2026-04-17: Migrated to kernel.** `runEidLookup` is a CLI adapter over `runWorkflow(eidLookupWorkflow OR eidLookupCrmWorkflow, { names, workers })`. The handler calls `runWorkerPool` inside `ctx.step("searching", ...)` — `runWorkerPool` is a helper, NOT a kernel mode. Per-name JSONL emit was deliberately dropped (one workflow run per CLI invocation); per-name results stay in `eid-lookup-tracker.xlsx`. Don't reintroduce raw `launchBrowser` in the handler. Don't try to switch to `runWorkflowBatch`/`runWorkflowPool` until the kernel grows a shared-context pool mode — today's pool launches one browser per worker, which would re-trigger Duo per worker. **Live run pending user verification** — UCPath + CRM Duo can't be approved this session, so only dry-run + tests validate this migration.
