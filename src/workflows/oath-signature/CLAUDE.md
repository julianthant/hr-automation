# Oath Signature Workflow

Add a new **Oath Signature Date** row to a UCPath Person Profile for one or
more employees.

**Kernel-based + daemon-mode.** Declared via `defineWorkflow` in `workflow.ts`
and executed through `src/core/runWorkflow` (single-item, `--direct`) or
enqueued to a daemon via `ensureDaemonsAndEnqueue` (default). Supports N EIDs
per invocation — each becomes its own queue item so a single daemon processes
them sequentially, and `--parallel K` fans out across K daemons.

## What this workflow does

Given one or more EIDs (plus an optional `--date MM/DD/YYYY`), for each EID:

1. Navigate to Person Profiles (direct URL).
2. Search by Empl ID (lands directly on the profile — EID is unique).
3. Extract the employee name and probe the page for an existing oath (the
   "There are currently no Oath Signature Date…" sentinel). If absent, skip
   add/save (live-page dupe-protection).
4. Click **Add New Oath Signature Date** → (optionally override the date)
   → **OK** → **Save**.
5. Click **Return to Search** so the browser is left on a clean search
   form for the next EID in the daemon queue.

## Selector Intelligence

This workflow touches: **ucpath**.

Before mapping a new selector, run `npm run selector:search "<intent>"`.

- [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
- [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md) —
  see the `oathSignature` group.
- [`src/systems/ucpath/common-intents.txt`](../../systems/ucpath/common-intents.txt)

### Iframe gotcha

Person Profile mounts inside `#ptifrmtgtframe` (name `TargetContent`), **not**
`#main_target_win0` used by Smart HR. The selector group exposes
`oathSignature.getPersonProfileFrame(page)` — use it instead of
`getContentFrame(page)`.

## Files

- `schema.ts` — `OathSignatureInputSchema` (`{ emplId, date? }`)
- `enter.ts` — `buildOathSignaturePlan` ActionPlan + `OathSignatureContext`
- `workflow.ts` — Kernel definition, CLI adapters (`runOathSignature`,
  `runOathSignatureCli`)
- `config.ts` — `UCPATH_PERSON_PROFILES_URL` deep link
- `index.ts` — Barrel exports

## Kernel Config

| Field         | Value                                                                          | Why                                                                                   |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `systems`     | `[ucpath]`                                                                     | One auth domain, one Duo.                                                             |
| `steps`       | `["ucpath-auth", "transaction"]`                                               | Matches `work-study` — auth phase + the single PeopleSoft transaction.                |
| `schema`      | `{ emplId, date? }`                                                            | EID is required; `date` defaults to UCPath's today-prefill on the detail form.        |
| `batch`       | `{ mode: "sequential", preEmitPending: true, betweenItems: ["reset-browsers"] }` | Daemon reuses the browser across items; `reset-browsers` prevents page-state leak.   |
| `tiling`      | `"single"`                                                                     | One browser window.                                                                   |
| `authChain`   | `"sequential"`                                                                 | Single system, no chain to interleave.                                                |
| `detailFields`| Employee / Empl ID / Signature Date                                            | Dashboard detail panel populates via `ctx.updateData` in the handler.                 |

## Data Flow

```
CLI: npm run oath-signature <emplId...> [--date MM/DD/YYYY]   (daemon — default)
  → runOathSignatureCli
    → ensureDaemonsAndEnqueue(oathSignatureWorkflow, inputs, { new, parallel })
      - Validates every {emplId, date?} via schema
      - Appends one enqueue event per EID to .tracker/daemons/oath-signature.queue.jsonl
      - Pre-emits `pending` tracker row per EID (dashboard populates instantly)
      - Wakes alive daemons; spawns new ones up to --parallel N (Duo 1×/daemon)
      - Each daemon pulls from the queue:
          • reset browser to about:blank (betweenItems)
          • handler → plan.execute() → add oath → OK → Save → return-to-search
          • dupe-protection: skip add/save if the existing-oath sentinel
            is absent on profile load (live-page probe)

CLI: npm run oath-signature:direct <emplId> [--date MM/DD/YYYY]   (legacy in-process)
  → runOathSignature — single EID only
    → if --dry-run: ActionPlan.preview() — prints the 8-step plan, no browser
    → else: runWorkflow(oathSignatureWorkflow, input)
```

## Dupe-protection

Single guard (tracker-side idempotency removed 2026-04-23):

- **Live page probe** — if the profile doesn't show the "no oath signature
  date" sentinel on load, the plan skips the add/OK/Save steps and marks
  the item `Skipped (Existing Oath)`. The existing-oath state on the live
  profile is the source of truth; a retry against the same EID converges
  correctly without a tracker-side cache.

## Gotchas

- **Iframe id differs from Smart HR** — see above. Using `#main_target_win0`
  here returns an empty frame and everything times out.
- **Return-to-Search retains the EID.** The search form re-renders with the
  prior Empl ID populated between iterations; `searchByEmplId` clears the
  field before filling it to avoid EID concatenation.
- **Two "Add New Oath Signature Date" anchors** exist (icon + text link)
  with the same accessible name. The selector anchors on the PeopleSoft id
  `DERIVED_JPM_JP_JPM_JP_ADD_CAT_ITM$41$$0` first, falling back to
  `getByRole("link", ...).first()`.

## Lessons Learned

- **2026-04-23: Removed tracker-side idempotency guard; only the live-page
  probe remains.** `src/core/idempotency.ts` was deleted repo-wide. The
  earlier two-guard design (live-page sentinel + `hashKey({workflow,
  emplId, date})` → `hasRecentlySucceeded`) collapses to one guard: if the
  profile shows "no oath signature date" on load, add + save; otherwise
  skip with `status: "Skipped (Existing Oath)"`. The live profile is the
  source of truth — a retry against the same EID converges correctly
  without a tracker-side cache.
- **2026-04-22: Initial implementation.** Mapped on EID 10873075 (Liam
  Kustenbauder). End-to-end live run verified: search → add → OK → save →
  return-to-search. Daemon mode wired from day one to match `work-study` /
  `separations`; multi-EID dispatch works out of the box because
  `ensureDaemonsAndEnqueue` accepts an input array.
