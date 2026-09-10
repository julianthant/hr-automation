# Handoff — e2e follow-up: Wave 1–4 improvements + unledgered tail

**Date:** 2026-06-12
**Paused at:** after the full stub-lane e2e run (phases 0–7 complete, triaged) and after planning the follow-up waves — before any Wave 1 execution.

## Task summary

The 2026-06-11 AI e2e run (`/e2e-test`, mode C stubs) exercised the full dashboard matrix and produced 19 ledgered findings. Since then, **other sessions already landed fix commits for every ledgered finding except E2E-004** (see "Already landed"). What remains is: close the run out properly (data-flow audit, E2E-004, re-verify the landed fixes live, refresh the report), then a planned set of harness and architecture improvements (Waves 2–4) that remove the bug *classes* rather than the symptoms, plus a tail of 9 small observations from the run that were never ledgered.

## Plan

No separate plan file — **this handoff is the plan** (waves below were agreed with the user 2026-06-12). The user wants ALL of it done, in wave order.

## Current state

- Branch: `master` (local only — never push)
- Worktrees: none
- HEAD (2026-06-12, after this session): `e7edf5a1 test(e2e): PII-free fixture-roster generator (Wave 2 #9)`
- Tree CLEAN. The "17-file uncommitted batch" the prior draft worried about already LANDED as `6a7f4cbb`/`3b94ad9e`/`809488ca`/`014d02dc` (it was clean at `014d02dc` when this session started).
- **Done this session (commits on master, local only):**
  - `52f3ac7d` E2E-004 fix (form-spec placeholders) — **the last open ledger item; all 19 findings now fixed**
  - `7018ee1c` dashboard StatPills refactor (a pre-existing uncommitted change from a prior session, swept in and given an honest message via local reword)
  - `74bbc2ec` Wave 2 #6 — one-shot fail gate (retry coverage)
  - `0809d5c0` Wave 2 #11 / T3 — Duo-log gated under stubs
  - `e7edf5a1` Wave 2 #9 — PII-free fixture-roster generator
  - Local-only (gitignored, not commits): E2E-004 marked `fixed` in `.e2e/20260611-2103/issues.jsonl`; both E2E-004 handoff copies deleted; `phases.md`/`SKILL.md` updated (retry leg + `/api/tasks`→sqlite + roster generator).
- Verification: full suite **2558 green**, lint clean, architecture **75/75**, `build:dashboard` green.
- Dashboard/daemons: all stopped; ports 3838/5173 free; playwright-cli sessions closed; no lockfiles.

## Where to resume (2026-06-12)

The code-bearing, non-stale items are DONE. What's left:
- **Wave 1 #2–5** — needs a LIVE dashboard session (stub lane) + the report-approval gate (yours). This is the main remaining body of work; best run via `/e2e-test` or a dedicated live driver session. The fixes to re-verify are listed in Wave 1 #2; the retry leg (Wave 2 #6) is now part of Phase 4.
- **Wave 2 #8** (i9 blank-signature fixture) — committable generator, but the value is a future live i9 leg and the PDF output can't be OCR-verified without a live run.
- **Wave 2 #10** — local skill-doc polish (one item NEEDS your call: T8 wfCounts).
- **Wave 3 #12/#13, Wave 4 #14** — the bug CLASSES are already fixed; these are defensive/purity/architectural refactors (see status notes below). #15 needs `/supe`.

## E2E run artifacts (evidence — keep)

- `.e2e/20260611-2103/` — `manifest.jsonl` (phase checkpoints), `issues.jsonl` (triaged ledger: 17 confirmed + 2 fixed-inline), `api/` dumps, `dashboard.log`, `report.html` (**written but NOT yet user-approved — approval gate still open**), `handoff.md` (the in-run Phase-8 handoff — now SUPERSEDED by the fix commits and this file), `make-roster.mjs`.
- `.screenshots/e2e/20260611-2103/` — all phase screenshots.
- `generated/.tracker-e2e/` — 27M evidence tracker root (rows/sessions/state.db/daemon logs).
- Real `.tracker/` residue from the pre-fix window: one `workers` row `per-7eee` status=dead (harmless).

## Already landed (do not re-fix)

My session's inline fixes:
- `f70c2fa1` fix(cli): dashboard honors HRAUTO_TRACKER_DIR (E2E-001)
- `f2c0b9eb` fix(daemon): env fallback for trackerDir (E2E-002)

Other sessions' fix batch (verify live in Wave 1, don't reimplement):
- `7e70d6a2` operation-row Discard sends OCR run identity (E2E-013)
- `b1c7b0c7` queued oath-upload rows present as Queued; cancel falls back queued/running (E2E-008)
- `8400c90b` approve fan-out itemIds from LOGICAL input; misses fail loud (E2E-015/018)
- `401971df` data.dryRun stamped on every orchestrator-emitted OCR row (E2E-016)
- `f7de7394` daemons wake on dependency resolution (E2E-017)
- `209f6923` rosterMode=download silent fallback retired (E2E-006)
- `b16bfc4b` delegated preps inherit coordinator trace prefix; standalone brands `oc-`; review-row ✗ routes through discard (VQ-1, E2E-007, E2E-012)
- `6055ca67` cancelled rows get own surfaces; discard cascades child tasks; verify/report polish (E2E-003/005/009/010/011/014)
- `aa253989` test pins for oc- branding; `3b94ad9e` review-feedback refactor; `6a7f4cbb` OCR anchors terminalize at release site; tree-scoped ticket cancel (E2E-003/009/010)
- `809488ca` CLAUDE.md lessons folded

**E2E-004 is the ONLY ledger item with no fix commit** (EC post-lookup re-stamp nulls printedName/employeeId in row records while the preview payload keeps them).

## The wave plan ← **resume at Wave 1**

### Wave 1 — close out the run (inline, no subagents)

- [x] 0. ~~Resolve the uncommitted 17-file batch~~ — DONE. That batch landed as `6a7f4cbb`/`3b94ad9e`/`809488ca`/`014d02dc` before this session; tree was clean at `014d02dc`.
- [x] 1. **Fix E2E-004** — DONE (commit `52f3ac7d`, 2026-06-12). Root cause was NOT a merge null-writer (the original diagnosis): the orchestrator's loading-phase placeholder skeleton (`src/workflows/ocr/orchestrator.ts`) was hardcoded oath-shaped for every form type, so an EC run's record SHAPE flipped mid-run. The ledgered "nulls in row records" was a projection artifact of reading EC-shaped records through oath keys — exhaustive artifact scan found ZERO null emissions, and EC identity survives under `employee.*` end to end. Fix: `OcrFormSpec.placeholderFields()` (EC seeds the nested skeleton; oath/verify keep the default). The lookup merge was already null-safe (E2E-014). Pinned by `orchestrator.test.ts` + `ocr-continuation.test.ts`. Ledger entry marked `fixed`. See the 2026-06-12 lesson in `src/workflows/ocr/CLAUDE.md`.
- [ ] 2. **Live re-verify the fix batch** in one stub-lane session (`HRAUTO_TRACKER_DIR="$(pwd)/generated/.tracker-e2e" HRAUTO_E2E_STUBS=1 npm run dashboard`; fresh tracker dir or wipe is fine — current one is evidence, consider `generated/.tracker-e2e2`): operation-row Discard button works (013); queued oath-upload row shows Queued and cancels from UI (008); approve fan-out → DISTINCT member item ids, members render N-not-1, dryRun in member `original_input_json` (015/016/018); dependency-resolved ticket claimed without manual `/wake` (017); modal rosterMode honored end-to-end (006); delegated preps share root trace prefix + standalone runs brand `oc-` (VQ-1/007); discard re-stamps operation row (012); no zombie queued `ocr` tasks after preps (003); cancelled rows out of failure surfaces (009); EC identity survives in row records post-fix-1 (004).
  - **Merge with the older live checklist** in `docs/superpowers/handoffs/2026-06-11-remaining-backlog.md` (8 items: running-OCR cancel ~1s, enrichment-cancel cascade, second-opinion name self-correction, re-run paths after fanOutAndWatch rewrite, EC deferred auth + blank-EID not fannable, per-record lookup evidence, sleep-purge lanes, RunModal reopen/duplicate/render fixes) — one dashboard session covers both lists.
- [ ] 3. **Probe the unledgered tail** during the same session (ledger each with evidence; fix one-liners on the spot):
  - T1 operation-row elapsed timer wrong ("0m 16s" on an 84-min-old row, oath-signature panel)
  - T2 member title formatting inconsistent in batch-anchor previews ("Nguyen, Ricky, V (10844087)" vs "Brusher, Kelly" + separate EID)
  - T4 `[OcrReviewPane] oath-signature renderer received non-oath record` — verify-mixed pushes EC records through the oath renderer
  - T5 `detailField 'terminationDate' declared but never populated` kernel warn on person-lookup (declared-but-never-populated IS a finding per row-details lens)
  - T6 duplicate-PDF check never fired on identical re-uploads despite oath-upload declaring `duplicateCheck` — one deliberate dup probe (NOTE: backlog handoff says a multi-file duplicate banner was since added — verify it covers the same-file-again case)
  - T7 verify-mode rows stamp `mode:"prepare"` in data
  - T9 confirm `209f6923` also fixed the lexicographic roster pick (`resolveRosterDirs()` no-arg + `files.sort().at(-1)` → should be deps.dir + mtime)
- [ ] 4. **Finish Phase 7**: data-flow audit inline (counts triangle wfCounts ≡ rows ≡ tasks; trace lineage across every delegation) over old + new evidence.
- [ ] 5. **Refresh `report.html`** (fixed-vs-open per finding, re-verification results), get user approval (gate from the e2e skill is still open), docs review LAST per skill; update `.e2e/20260611-2103/issues.jsonl` statuses to `fixed-verified` where the live pass confirms.

### Wave 2 — harness + fixtures (small, independent)

- [x] 6. **Scripted failure mode + retry coverage** — DONE (this session). One-shot fail gate `<wf>--fail-at--<step>.fail` under `e2e-gates/`: `e2eGateFailPath` (`tracker/paths.ts`), `consumeFailGate` + `E2EScriptedFailError` (`core/e2e/gates.ts`, a non-cancel throw → terminal `failed` + Retry), wired into `cloneWithScriptedSteps` after the hold release / before the success patch; self-consuming so the `original_input_json` replay passes. Retry leg added to the skill matrix (`phases.md` Phase 4 #4 + `SKILL.md` Phase 4 one-liner) and documented in `src/core/CLAUDE.md`. Pinned by `gates.test.ts` + `stub-workflows.test.ts` (organic fail → no success data → retry replay → done).
- [x] 7. **Distinct stub EIDs** — ALREADY LANDED before this session (`stubEidForName`, `stub-workflows.ts` — name-hash `1xxxxxxx` EID; commit `6055ca67` per the E2E-014 ledger resolution). No further work.
- [ ] 8. **i9 fixture**: synthetic oath PDF with BLANK authorized-official signature (i9-lookup dispatch condition, `orchestrator.ts` ~1079) — HTML → print-to-PDF generator script + `tests/data/` fixture; add i9 leg to the matrix docs.
- [x] 9. **Roster fixture generator** — DONE, but NOT as written. The premise (check the roster `.xlsx` into `tests/data/`) **conflicts with the PII policy**: `.gitignore` keeps `tests/data/*.pdf` out as "may contain PII" and `*.xlsx` globally, so a roster of the same real names+EIDs is PII too and must not enter git history. Instead committed a PII-FREE generator `tests/data/make-e2e-roster.mjs` that reads identities from a gitignored local sidecar `tests/data/e2e-roster-identities.json` (real names+EIDs, kept local) and writes `tests/data/e2e-fixture-roster.xlsx` (also gitignored). The sidecar was written locally with the 8 identities, so an operator regenerates the fixture deterministically (no re-OCR) with `node tests/data/make-e2e-roster.mjs`. Skill Phase 0 (`SKILL.md`) updated to use the generator + sidecar bootstrap. Only the generator is tracked.
- [~] 10. **e2e skill doc corrections** (`.claude/skills/e2e-test/SKILL.md` + `references/phases.md` — gitignored local skill docs) — PARTIAL:
  - [x] `/api/tasks` is NOT a route — `phases.md` now points at `sqlite3 <tracker>/state.db "SELECT … FROM tasks"` (verified: only `/api/task-dependencies` + `/api/runs` exist). `/api/runs` needs workflow+id+date params.
  - [ ] hold-gate sequencing: oath/EC preps ALWAYS fan person-lookup verifies — pre-creating `person-lookup.hold` in Phase 0 stalls Phase 1 reviews; arm it only for the verify-variant window
  - [ ] dropzone uploads need `setInputFiles` via run-code, not `playwright-cli upload`
  - [ ] same-PDF re-runs are page-cache fast — mid-extraction cancel tests need a never-seen PDF
  - [ ] wfCounts semantics: counts are all rows in day view (cancelled included), NOT active-only — fix the Phase-2 "wfCounts decrements" assertion **(T8 — NEEDS USER ADJUDICATION before editing; left as-is this session)**
  - [ ] Phase 7: consolidate to 2 verifier agents (4 heavyweight verifiers found little the driver hadn't; 2 of them died to the spend limit)
  - [ ] remove the `/wake` workaround note once E2E-017 verifies (E2E-017 is fixed; verify live in Wave 1 first)
- [x] 11. **T3 misleading stub-lane log copy** — DONE (commit `0809d5c0`). `client.ts:225` "Approve Duo(s)…" is now gated on `process.env.HRAUTO_E2E_STUBS !== "1"` (the spawn line itself stays). See `src/core/CLAUDE.md` E2E-stub section.

### Wave 3 — targeted refactors (parallel-safe pair; worktree discipline if concurrent)

> **2026-06-12 status:** both bug CLASSES these refactors target are already
> NEUTRALIZED by landed fixes — these are now defensive/purity refactors, not
> bug fixes. De-prioritized below the live Wave-1 verification.

- [ ] 12. **Server-resolved mutation targets** (E2E-008/013 class) — **core already landed**: `cancelTarget` (`perform-workflow-action.ts:93-123`) treats the client `status` as ADVISORY and falls through on a `code:"wrong-state"` 409 from either handler (the E2E-008 fix, commit `6055ca67`/`6a7f4cbb`); the discard proxy overrides the descriptor target with the server-derived OCR run identity (E2E-013, `7e70d6a2`). Residual = the PURITY refactor (resolve control_state straight from the tasks table by (workflow,id,runId); strip forwarded state entirely from UI calls). Low value now — the class is closed; only do it for cleanliness.
- [ ] 13. **Explicit member spec at approve time** (E2E-015/016/018 class) — **bugs already fixed** (`8400c90b`/`401971df`): the id resolver keys by the logical input + fails loud, and `data.dryRun` is stamped on every OCR row. `readDryRun`/`walkOcrJsonl` rediscovery STILL exists in `approve.ts`/`shared.ts` — retiring it for one explicit `{itemId,input,runtimeOptions}` per record is a DEFENSIVE refactor (regression risk across the whole approve path). Add a scenario test (member inputs carry identity+options end to end) first if attempted.

### Wave 4 — architectural (design first)

- [ ] 14. **`fieldSources` provenance map** — NOT started (no `fieldSources` in `src/`). `fieldSources: Record<field, 'paper'|'roster'|'lookup'|'manual'>` on OCR records, stamped at extraction + merge; preview labels and completeness report DERIVE from it (subsumes the E2E-004/005 class permanently). Files: `src/dashboard/components/ocr/types.ts`, orchestrator merge, `OcrReviewPane`/readonly-record, `src/services/ocr/forms/*`. NOTE: E2E-004 itself is already fixed at the placeholder layer (`52f3ac7d`); #14 would make provenance a first-class field rather than inferring shape.
- [ ] 15. **Declarative cascade policy in the task store** (the hard one — run `/supe` first for brainstorm + plan): single rule table (parent-cancel → cancel children; child-terminal → re-stamp coordinator) replacing per-site propagation. Kernel-level, regression risk across every delegation flow; land LAST. Check first how much `6a7f4cbb`/`6055ca67`/`f7de7394` (release-wakes-daemons + anchor-terminalize-at-release) already generalized.

## Open questions / deferred decisions

- ~~Q: The 17-file uncommitted batch~~ — RESOLVED: it already landed (`014d02dc` and earlier); tree was clean at session start.
- Q: T8 wfCounts semantics — skill doc says "decrements on cancel", implementation counts all rows in view. — current thinking: the implementation is intentional (badge = day-view rows); fix the skill doc, but let the user adjudicate. **Still open — left the Phase-2 assertion as-is this session.**
- Q: `report.html` approval gate — still open; present after the Wave-1 live refresh.
- Q: Monthly API spend limit killed 2 verifier agents mid-Phase-7. — current thinking: run Wave 1 inline, no subagents; use parallel dispatch only if the limit was raised.
- Adjudicated elsewhere (do NOT reopen, per 2026-06-11-remaining-backlog.md): `runtimePolicy.prepRow/memberRow` kept; orchestrator `runFanOutPhase`/reocr-whole-pdf not migrated onto `fanOutAndWatch`.

## Verification before resuming

```bash
git status                      # expect the 17-file batch unless it landed; ask user if unsure
git log --oneline -15           # confirm HEAD ≥ 809488ca and the 10 fix commits present
npm run typecheck && npm run test && npm run test:architecture && npm run lint
ls generated/.tracker-e2e/e2e-gates/   # expect empty (no stale .hold files)
lsof -nP -iTCP:3838 -sTCP:LISTEN       # expect free
```

## Pointers

- Ledger + manifest: `.e2e/20260611-2103/issues.jsonl`, `manifest.jsonl`, `report.html`
- Older parallel workstream (live checklist to merge into Wave 1): `docs/superpowers/handoffs/2026-06-11-remaining-backlog.md`
- Superseded in-run handoff: `.e2e/20260611-2103/handoff.md` (its fix list is DONE; ignore)
- e2e skill: `.claude/skills/e2e-test/SKILL.md` + `references/phases.md`, `references/verification.md`, `references/report-handoff.md`
- CLAUDE.md: root, `src/core/CLAUDE.md`, `src/workflows/oath-upload/CLAUDE.md`, `src/workflows/CLAUDE.md`, `src/dashboard/CLAUDE.md`, `src/tracker/CLAUDE.md`
- Memory: `feedback_daemon_autospawn_semantics.md`, `feedback_uniform_retry_no_gating.md`, `feedback_fail_loud_over_auto_correct.md`, `reference_dashboard_restart_required.md`, `feedback_playwright_cli_real_chrome.md`
- Stub-lane env: `HRAUTO_TRACKER_DIR="$(pwd)/generated/.tracker-e2e" HRAUTO_E2E_STUBS=1 npm run dashboard` (backend never hot-reloads; verify `[e2e-stubs] SCRIPTED` banner in daemon logs before enqueueing; never enqueue onboarding/separations/work-study/crm-doc-download under stubs; never use roster "download" in stub lane)
