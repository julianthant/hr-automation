# E2E run 20260614-0407 — COMPLETE (all findings fixed)

## Outcome
Full Mode-C AI e2e of the dashboard (stub daemons, isolated tracker, real Gemini OCR),
driven headed via playwright-cli. **Every prior fix re-validated (11)** and the full
matrix passed (18 enqueues, cancel matrix, fail-injection→retry exercised end-to-end for
the first time, parallel-worker matrix). The run surfaced **6 findings (1 medium + 5 low);
ALL 6 are now FIXED** via the promotion gate (pin red → fix root → green).

**Combined verification:** full suite 329 files / 2591 tests pass · architecture 75/75 ·
lint clean.

## Fixes landed (local commits on master — pushed to origin per user instruction)
| Finding | Fix | Pin | Commit |
|---|---|---|---|
| E2E-105 (med) — stop-all orphans queued tasks | `/whoami` reports `shuttingDown` + `filterPeersAvailableForHandoff` gates the queued sweep so the last responsive owner terminalizes queued AT teardown (no 5-min gap / no dashboard-uptime dependency) | `daemon-teardown-soak.test.ts` (cranked 50×) | `f892c1e5` |
| E2E-101 (low) — dup terminal row on signal-wait cancel | runId-keyed terminal-write guard (`runRegistry.claimTerminalWrite`) + kernel suppresses its row for any daemon-path cancel | `daemon.test.ts` | `f892c1e5` |
| E2E-103 (low) — member badge folds cancelled→failed | `aggregateBatchCounts` gained a `cancelled` bucket (via `statusKeyForEntry`); StatusCounts + progress segments render it | `delegation-row-helpers.test.ts` | `36ceaa0e` |
| E2E-106 (low) — coordinator chip = member rollup | `operationSurfaceStatus` returns the coordinator's OWN status when members exist; uniform across oath-sig/EC/oath-upload | `operation-coordinator-chip.test.ts` | `ea2f5475` |
| E2E-102 (low) — no coordinator tree-cancel | "Cancel remaining members" footer button → `/api/cancel-queued` `scope:tree` (reused existing `collectDescendants` BFS) | `operation-cancel-tree.test.ts` | `2cd1128f` |
| E2E-104 (low) — Stop button flush at viewport bottom | terminal-drawer card strip `py-3`→`pt-3 pb-5` | `terminal-drawer.test.ts` (class assertion) | `1e70eb8e` |

Plus doc/lesson commits: `d9172e49`, `97eeb39d`; CLAUDE.md lessons folded into the fix
commits where relevant; `docs/engineering/daemon-teardown-state-machine.md` open-gap
section marked CLOSED. `.gitignore` updated (un-ignore `docs/engineering/**`, ignore
`generated/e2e-*` harness scripts).

## The ONE remaining follow-up (pre-existing, NOT from this run)
`tests/unit/systems/selector-staleness.test.ts` fails on `master` independent of these
fixes — some Playwright selectors were last `// verified <date>` more than the 90-day
threshold ago. It's a maintenance nag, not a code bug. **Resolution (operator action):**
re-verify the stale selectors against live UCPath (needs Duo/live access) and bump their
`// verified <date>` comments, OR raise the threshold via `SELECTOR_STALENESS_DAYS` if a
re-verification is scheduled. All e2e verification used `SELECTOR_STALENESS_DAYS=3650` to
isolate this. To find the offenders: `npx vitest run tests/unit/systems/selector-staleness.test.ts`.

## Artifacts (local, gitignored)
- `.e2e/20260614-0407/` — `report.html` (open it), `manifest.jsonl` (45 checkpoints),
  `issues.jsonl` (6 findings, all `status:fixed` with `regressionTest`+`fixCommit`),
  `api/*.json`, `dashboard.log`.
- `.screenshots/e2e/20260614-0407/` — 22 screenshots.
- `generated/.tracker-e2e/` — evidence tracker (~30 MB).

## Re-create the stub-lane env (for future runs)
```bash
mkdir -p generated/.tracker-e2e/e2e-gates generated/.tracker-e2e/rosters
cp tests/data/e2e-fixture-roster.xlsx generated/.tracker-e2e/rosters/   # NEVER SharePoint download in stub lane
export HRAUTO_TRACKER_DIR="$(pwd)/generated/.tracker-e2e"; export HRAUTO_E2E_STUBS=1
npm run dashboard    # verify [e2e-stubs] SCRIPTED banner in daemons/*.log before enqueueing
```

This handoff records a COMPLETED run; there is no deferred work to execute. Delete it
once the selector-staleness follow-up is scheduled/closed.
