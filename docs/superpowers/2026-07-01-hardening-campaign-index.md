# Flakiness-hardening campaign — PARALLEL index

**Date:** 2026-07-01. **Goal:** harden each HR-automation workflow against flakiness, then live-verify each end-to-end. Onboarding + the Duo ISS-005 flake are DONE (committed). This index coordinates running the REST in parallel — one paste-ready handoff per task (files listed below).

## How to run in parallel (READ FIRST)

The tasks are **not** all independent — they share systems files. Run in **waves**:

### Wave 0 — cross-cutting FIRST (land on master before fanning out)
These touch shared files that the workflow tasks build on. Do them first (one session, or serially), merge to master, THEN start Wave 1.
- **`2026-07-01-ocr-orchestrator.md`** — shared OCR orchestrator (`src/workflows/ocr/orchestrator.ts`), used by emergency-contact + oath-signature + onbase + oath-upload.
- **`2026-07-01-shared-helpers.md`** — `ctx.retry` cancellation (`src/core/kernel/ctx.ts`), `clickIfPresent` `.first()` (`src/systems/common/safe.ts`).

### Wave 1 — workflows in parallel (each in its OWN git worktree + branch `feature/harden-<wf>`)
Group so no two concurrent sessions edit the SAME systems file. Suggested safe groups (run groups in parallel; within a group, serialize or accept merge conflicts the orchestrator resolves):
- **Group ucpath** (conflict on `src/systems/ucpath/*`): `separations`, `person-lookup`, `work-study` — these three overlap on UCPath; ideally serialize, or run in worktrees and let the orchestrator resolve merges.
- **Group ocr-backed** (own `enter.ts`/`workflow.ts`; the shared orchestrator was hardened in Wave 0): `emergency-contact`, `oath-signature`, `onbase`, `oath-upload` — parallel-safe among themselves once Wave 0 landed.
- **Group standalone**: `kronos` (old+new), `i9` — mostly isolated (but coordinate `i9` with the in-flight i9-SSO parallel work).

### ⚠ Live-verify is NOT parallel-safe — serialize it
Code-harden all workflows in parallel worktrees, BUT the **live-verify daemon runs must be serialized**. Two reasons: (1) there is ONE shared Duo WebAuthn authenticator and `signCount` is global server state — concurrent live auths collide/desync; (2) live runs drive the same live UCPath/CRM/Kuali systems. So: fan out the code work, then run the live dry-runs **one at a time** (each on its own isolated tracker dir + fallback port, torn down before the next). The dashboard boot log says "Hands-off Duo ON" — only one such ceremony at a time.

### Worktree discipline (per your global CLAUDE.md — MANDATORY for parallel)
Each session: `git worktree add ../harden-<wf> -b feature/harden-<wf>`, commit ONLY on that branch, do **NOT** merge. The orchestrator (you, later) merges each `feature/harden-<wf>` to master with `--no-ff` sequentially, resolves conflicts, then `git worktree remove` + `git branch -d`. Never leave idle worktrees.

## Current state (all sessions must know)

- **Branch `master`**, no worktrees yet. My committed campaign work: `5d96b30b 6f1b2b96 1d64e9db d250edb9 ebf89b3f bcdda8de 344a324c`.
- **⚠ The large uncommitted diff in the tree is a PARALLEL session's work** (Capture tunnel, OCR dashboard, i9-SSO, LLM triage). Do NOT touch/stage/commit/revert it. **Never delete a failing test to get green** (a subagent did that this session; caught + reverted). Verify with SCOPED tests — full `npm run test` may be red from that parallel work.

## Shared live-verify methodology (every workflow reuses this)

1. `npm run typecheck` + scoped `npx vitest run tests/unit/systems/<sys>/ tests/unit/workflows/<wf>/` + `npm run test:architecture` — green.
2. Boot the real dashboard on an **isolated** tracker dir + a **fallback port** (NEVER the user's 3838 — pick a per-session port e.g. 3941/3942/…): `HRAUTO_TRACKER_DIR=$(pwd)/generated/.live-verify/<wf> npm run dashboard:prod -- --port 39NN` (background; poll `curl :39NN`).
3. Drive headless via **`playwright-cli`**: open `:39NN/?wf=<wf>`, `snapshot` for refs, fill the input/upload panel, toggle **dry-run**, click Run. Duo clears hands-off ("Hands-off Duo ON" in the boot log). Upload workflows use the `RunModal` PDF picker.
4. A **background bash waiter** greps the isolated `logs/<wf>-<date>.jsonl` for `"event":"run:terminal"`, then dumps the step timeline + `screenshots/`. **Read the key screenshot to confirm the right thing was clicked** (the whole point of this campaign).
5. **Restart the daemon after EVERY code change** — tsx does NOT hot-reload a running daemon.
6. Cleanup: `pkill -f "dashboard --prod --port 39NN"` + `playwright-cli close-all`.

### Gotchas that cost time (don't repeat)
- **Interactive `playwright-cli` findings ≠ real daemon behavior.** Confirm every fix in the real daemon, not just interactively (the person-search fix took 4 rounds over exactly this).
- **UCPath person-search:** the National Id magnifier is LOAD-BEARING (fires the FieldChange that enables Search); its "no prompt values" dialog + `#pt_modalMask` are on the **MAIN page**, not the `#main_target_win0` iframe. See `src/systems/ucpath/LESSONS.md`.
- Some CRM test records lack SSN and/or DOB; UCPath person-search needs one, onboarding's I-9 needs both.
- Duo ISS-005 (slow first SSO→Duo transition) is FIXED (`selectDuoFactor` keeps waiting while pre-prompt) — if a fresh daemon's first auth is slow, that's expected-and-recovers now.

## Verification before any session starts

```bash
git status                       # on master; my 7 commits present; large parallel-work diff untouched
git log --oneline -8
npm run typecheck                # clean
npm run test:architecture        # 79 pass
```

## Per-task handoffs (one paste-ready file each, in `docs/superpowers/`)
- `2026-07-01-ocr-orchestrator.md` (Wave 0) · `2026-07-01-shared-helpers.md` (Wave 0)
- `2026-07-01-onbase.md` · `2026-07-01-separations.md` · `2026-07-01-emergency-contact.md` · `2026-07-01-oath-signature.md` · `2026-07-01-person-lookup.md` · `2026-07-01-oath-upload.md` · `2026-07-01-work-study.md` · `2026-07-01-kronos.md` · `2026-07-01-i9.md`

## Pointers
- Full audit seed + status: memory `~/.claude/projects/-Users-julianhein-Projects-hr-automation/memory/flakiness-hardening-campaign.md`
- Done-work lessons: `src/systems/ucpath/LESSONS.md`, `src/infra/auth/CLAUDE.md` (both 2026-07-01), `src/workflows/onboarding/CLAUDE.md`
- Root `CLAUDE.md` "Live verification — standing pre-authorization" (Duo autopilot, dry-run safety boundary)
