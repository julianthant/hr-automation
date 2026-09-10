# Handoff — e2e-test full run (stub matrix done, live lanes + fixes pending)

**Date:** 2026-06-18
**Paused at:** Stub-lane Phases 0–6 complete. Next: implement solo UI fixes (USR-001/USR-002) in a subagent → run live lanes (onboarding + 8-worker separations dry-runs, **Duo is hands-off automated**) → remaining fixes (USR-003/004 + OBS-002/003) with regression pins → report. Also: bake new standing rules into the e2e-test skill (below).

## Task summary

Running the `/e2e-test` skill (scope **A**: full stub matrix THEN live lanes) against the real dashboard, with **extra focus on separations + onboarding**. Goal: confirm the dashboard/kernel/daemon machinery works end-to-end, the dry-run submits nothing, and **separations runs at 8 parallel workers** with all workers spawning, running in parallel, and doing the task properly. The user also requested 4 specific product fixes discovered mid-run (USR-001…004).

**Architecture fact (load-bearing):** separations is a *sequential batch per daemon*, but `parallelWorkers:8` spawns **8 independent separation daemons** (each its own 4 browsers), dividing the queued doc ids via SQLite atomic claim. `computeSpawnPlan(alive, {parallel:8})` spawns `8 - alive`. Cap = 8 (`MAX_PARALLEL_WORKERS`, `src/domain/run-options.ts`). This is real OS-process parallelism (`spawnDaemon` → `child_process.spawn`, `src/core/daemon/registry.ts:488`), not Node threads.

## NEW STANDING RULES the user gave (must be baked into the e2e-test skill `SKILL.md` + followed now)

1. **Never stop until everything is done.** Drive the whole e2e to completion autonomously.
2. **No mid-run questions.** Don't ask the user anything midway — pick the best option and proceed.
3. **Run each phase in a subagent** to conserve orchestrator-agent tokens. (Caveat: only ONE agent touches the playwright-cli browser at a time — sequential subagents are fine; never concurrent browser drivers.)
4. **Duo is hands-off automated.** The dashboard logs `Hands-off Duo ON — daemon logins auto-approve via the enrolled WebAuthn key`. The live lanes do NOT need the user present. The "ask first / user present for Duo" safety rails in the e2e skill's live-lane section are obsolete in this environment — treat live lanes as runnable autonomously (still dry-run, still isolated tracker).
5. **Separations-specific verification:** make sure the **separation date is correct**, that it flows to **Kronos correctly**, and that it **scrapes the right data**.

## Current state

- Branch: `master` (clean working tree; no code committed yet — fixes come in Phase 8).
- Dashboard: was running with `HRAUTO_E2E_STUBS=1` + `HRAUTO_TRACKER_DIR=…/generated/.e2e/tracker` (started pid 79623). **The :3838 pid changed to ~5016 at handoff time — RE-VERIFY env before trusting stub mode** (see Verification). If it restarted without the env, it's hitting the REAL `.tracker/` — stop and restart correctly.
- playwright-cli session name: **`e2e`** (headed, real Chrome). Close at teardown; sweep orphans.
- Run workspace: `generated/.e2e/runs/20260618-0243/` → `manifest.jsonl` (26 checkpoints), `issues.jsonl` (ledger), `api/` dumps, `dashboard.log`.
- Screenshots: `.screenshots/e2e/20260618-0243/`.
- Isolated tracker: `generated/.e2e/tracker/` (state.db, rows/, sessions/, daemons/, e2e-gates/, rosters/e2e-fixture-roster.xlsx). Prior run archived to `generated/.e2e/tracker.bak-20260618-024425`.
- Hold gates: all released (none remain). Re-arm per phase as needed (`<trackerDir>/e2e-gates/<wf>.hold`).

## Progress

- [x] Phase 0 — Setup (isolated tracker + stubs verified on backend env, clean baseline, fixture roster seeded)
- [x] Phase 1 — Enqueue matrix: 18 runs (9 standalone OCR oc-×6/vf-×3 + 9 delegated os-/ec-/ou-×3); shapes/traces/delegation/dependency-gating all verified
- [x] Phase 2 — Cancel queued (oath-upload run3 → orange, SQLite cancelled, trace preserved) + OCR discard cascade (op+OCR→discarded, queued children pruned)
- [x] Phase 3 — Cancel running (cooperative cancel + daemon REUSE proven: oath-upload daemon survived, claimed next)
- [x] Phase 4 — Survivors: operation-member fan-out (identity/no-orphan/prefix), preview-correctness, Open-OCR-review link, **fail-inject ×2 families (oath-signature + emergency-contact) → red Failed → member Retry → pristine `original_input_json` replay → done**, standalone no-approve
- [x] Phase 5 — Parallel workers: **spawn exactly N=3 (no overspawn), distribute across all 3 daemons, reuse**; auto-no-overspawn code-verified. (stop-instance reassign + Stop-All DEFERRED to live 8-worker separations teardown + unit-pinned.)
- [x] Phase 6 — Resilience: reload rehydration, counts triangle (oath-sig rail 4≡4), row-lifecycle 625 rows/0 stuck-retry, 0 invalid-line spam
- [ ] **Solo fixes in a subagent — USR-001 (delegated-runs log-panel tab) + USR-002 (daemon_phase log spam)** ← resume here
- [ ] Update `e2e-test/SKILL.md` with the 5 standing rules above
- [ ] Live lane A — Onboarding dry-run (email `dong7777125@gmail.com`, Dry run ON, 8 steps, NO Smart-HR submit). Duo auto.
- [ ] Live lane B — **Separations 8-worker dry-run** (doc ids `4131,4130,4129,4128,4127,4126,4125,4124,3917`, parallelWorkers=8, Dry run ON). Verify: all 8 daemons spawn + run in parallel; **separation date correct**; Kronos date flow + right data scraped; NO UCPath submit + NO Kuali finalization; regression guards (auth/idle-refresh, modal-mask, short-EID delegation, worker-utilization bucket, Kuali 3-slice / Kronos viewport audit screenshots). Duo auto.
- [ ] Phase 7 — Verifier subagents (queue/preview/sessions/logs + dataflow auditor) over all evidence
- [ ] Phase 8 — Fix all 7 findings (USR-001…004 + OBS-002/003; OBS-001 is doc-only) each with a `/test-writer` red→green regression pin + before/after; review-code; ui-ux-pro-max for USR-001; docs LAST
- [ ] Phase 9 — HTML report (`generated/.e2e/runs/20260618-0243/report.html`) + this handoff updated/retired

## Findings ledger (`generated/.e2e/runs/20260618-0243/issues.jsonl`)

- **USR-004 (HIGH)** — same `single-oath.pdf` → different EIDs across runs (correct `10000001`=Barahona Martell vs off-roster `19803556` from a "Barbara" misread). Roster-REQUIRED oath accepted an OFF-ROSTER person-lookup EID for a Gemini name-misread. Fix dir: roster-required forms must require a roster match (reject off-roster EID) and/or trigger second-opinion re-OCR on roster-MISS even when person-lookup returns an EID. **Wrong-person risk.**
- **USR-002 (med)** — `daemon_phase` events flood the per-run log stream (102 in session file vs 67 item_start). Drop from merged 'all'/Logs stream (like `step_change` in `LogStream.tsx mergeDisplayItems`) and/or cut emit cadence in `tracker/session-events`.
- **USR-003 (med)** — names inconsistent: `RAMIREZ ROSAS, Juan, A.` all-caps vs `Brusher, Kelly` title-case. Normalize person display name at presentation (`src/domain/queue-row-presentation.ts`).
- **USR-001 (low/feature)** — add a "Delegated" tab/surface in the log panel beside Logs/Screenshots/Preview to view delegated runs with detail (move the "DELEGATED RUNS (N)" section there). `LogStream.tsx`.
- **OBS-002 (med)** — approve fan-out pending/started `operation-member` rows lack the composed `__traceId` (shows None/'' until... corroborated at session-event layer: Oath Signature 2/3 `item_start` traceId=''). Trace-rides-every-row contract gap on the fan-out pre-emit/start path.
- **OBS-003 (med)** — operation-coordinator "Retry this run" retried a DONE member (r3) instead of the FAILED member (r0). Member-level retry works; coordinator-level mis-targets.
- **OBS-001 (low, doc)** — OCR CLAUDE.md says dependency mode "still returns at awaiting-approval; scheduler patches as lookups finish" but it gates approval until lookups complete. Reconcile wording (behavior is arguably correct).

## Verification before resuming

```bash
cd /Users/julianhein/Documents/hr-automation
# 1) Is the dashboard still in STUB mode + isolated tracker? (CRITICAL — pid changed at handoff)
lsof -ti tcp:3838 | head -1 | xargs -I{} sh -c 'ps eww {} | tr " " "\n" | grep -E "HRAUTO_E2E_STUBS|HRAUTO_TRACKER_DIR"'
#   MUST show HRAUTO_E2E_STUBS=1 and HRAUTO_TRACKER_DIR=.../generated/.e2e/tracker
#   If NOT: kill it and restart:
#     HRAUTO_TRACKER_DIR="$(pwd)/generated/.e2e/tracker" HRAUTO_E2E_STUBS=1 npm run dashboard > generated/.e2e/runs/20260618-0243/dashboard.log 2>&1 &
curl -s http://localhost:3838/api/runs >/dev/null && echo "dashboard up"
playwright-cli list   # confirm/recreate session "e2e"
git status
```

### Live-lane env (when starting live lanes — NOT before)
```bash
# Restart backend WITHOUT stubs, KEEP isolated tracker. Duo auto-approves (hands-off).
# kill the stub dashboard first, then:
HRAUTO_TRACKER_DIR="$(pwd)/generated/.e2e/tracker" npm run dashboard > generated/.e2e/runs/20260618-0243/dashboard-live.log 2>&1 &
# Onboarding: rail Onboarding → InputRunPanel → email dong7777125@gmail.com → gear → Dry run ON → Run
# Separations: rail Separations → InputRunPanel → "4131, 4130, 4129, 4128, 4127, 4126, 4125, 4124, 3917" → gear → workers=8 + Dry run ON → Run
```

## Pointers

- Skill: `.claude/skills/e2e-test/SKILL.md` (+ `references/phases.md`, `verification.md`, `report-handoff.md`) — UPDATE SKILL.md with the 5 standing rules.
- Separations: `src/workflows/separations/{workflow.ts,CLAUDE.md,steps/kronos-search.ts}`; dry-run terminal is after Kronos date reconciliation, before BOTH writes. Separation-date logic: `resolveKronosDates` (Kronos wins), `computeTerminationEffDate`, `computeKronosDateRange` in `schema.ts`.
- OCR matching (USR-004): `src/services/ocr/forms/{oath.ts,registry.ts}`, `src/workflows/ocr/orchestrator.ts` (roster resolve + match + person-lookup fallback), second-opinion in `src/services/ocr/pipeline.ts`.
- Log panel (USR-001/002): `src/dashboard/components/log-panel/LogStream.tsx` (`mergeDisplayItems`, surface tabs, `parseInitialTab`).
- Names (USR-003): `src/domain/queue-row-presentation.ts`.
- Worker model: `src/core/daemon/{registry.ts,client.ts}`, `src/domain/run-options.ts`.
- Fixtures: `tests/data/{multiple-oath,single-oath,emergency-contacts}.pdf`, `tests/data/e2e-fixture-roster.xlsx` (+ sidecar `e2e-roster-identities.json`, PII, gitignored).
- Memory: `~/.claude/projects/-Users-julianhein-Documents-hr-automation/memory/MEMORY.md` (branch/commit strategy, test-writer pins, scenario test layer).
