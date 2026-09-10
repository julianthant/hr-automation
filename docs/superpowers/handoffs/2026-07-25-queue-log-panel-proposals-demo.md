# Handoff — queue-row / log-panel enrichment proposals + rebuild demo

**Date:** 2026-07-25
**Paused at:** all mock/demo work built, verified, and committed — awaiting operator keep/cut decisions before ratifying into `docs/rebuild/03-tracker-dashboard.md`

## Task summary

Part of the **rebuild program** (memory: `rebuild-program-temp_src`). The operator asked how to enrich queue rows and the Log Panel with the data the tracker already records ("modify or add the existing data in their places" — NOT a restyle; the ratified visual-parity directive holds), how to serve 50-member groups, and finally for a **full production-like demo where every row drives its own custom log panel**. Three deliverables were built in sequence, each grounded in the ratified rebuild model (3 row types Run/Group/Member, review-as-status, 8 statuses, 5-tab Log Panel, `QueueSurfaceWire` — see `docs/rebuild/reviews/second-look-2026-07-22.md` D1–D5 + §Log Panel):

1. **Proposal catalog** — 26 toggleable proposals: P1–P8 (row content: outcome facts, micro-pipeline, warnings, gate reason, attempt lineage, evidence, queue-wait, live OCR phase), V1–V4 (variants/organization: rejected member look, write-parked look, attention bands, day digest), L1–L10 (log panel: structured chips, step grouping, strip hover, data pills, event cards, pinned outcome bar, stream search, new-lines pill, filmstrip, waterfall), G1–G4 (group scale: density ladder, 50-member status matrix, triage drill-in table, review conveyor + operator check-marks).
2. **UI gallery "Proposals" tab** (`?view=ui-gallery` → Proposals, `src/dashboard/components/dev/proposals/`) — every proposal as a pill toggle in the real skin, before/after cells vs the real `EntryItem`, interactive 5-tab log-panel mock, in-tab ledger tagging each proposal's data source (render-only / wire addition / new stamp).
3. **Living demo** (`?view=rebuild-demo`, `src/dashboard/components/dev/rebuild-demo/`) — production-feeling two-panel app on synthetic data: 11 top-level rows covering all 3 row types × all 8 statuses + 62 generated members; **every row derives its own log panel** (state-driven default tab, outcome bar, strip+hover, waterfall, filmstrip, per-tab surfaces, member conveyor with working Mark-checked); working filters, matrix, drill-in, live tick, global keyboard (j/k · n · Enter · Esc · c · 1–5).

**Key design position (operator asked, answer ratifiable):** 3 row types are enough — member count is a continuous property, so scale is a presentation ladder on Group Row (≤5 full rows · 6–20 compact lines · 20+ matrix + drill-in), never a fourth type.

## Plan

- No superpowers plan file — this was mock-driven design work following the rebuild working style (memory: `orchestrator-subagent-design-process`: plain-language part-by-part operator sign-off). The "plan" is the ratification pipeline in Progress below.
- An earlier standalone HTML mock artifact exists (claude.ai artifact "Queue Row & Log Panel Enrichment — Proposals", `6db5d548-…`); superseded by the gallery tab + demo.

## Current state

- Branch: `master` (local only, 18 commits ahead of origin — **never push without explicit instruction**)
- Worktrees: one pre-existing stale i9 worktree = user's committed copy, don't remove (memory: `remediation-program-m7-complete`)
- Uncommitted changes: clean (a pre-existing `stash@{0}` is not ours — leave it)
- This session's commits, all verified (typecheck:all · lint · test:architecture 137 · full suite 459+11 files · build:dashboard · headless playwright passes):
  - `98d824af` fix(lint) — 3 pre-existing lint errors (OcrReviewPane assertion, i9-check type-only tuple + `matched[0]!`)
  - `e623e16a` gallery Proposals tab (P1–P8, V1–V4, L1–L5)
  - `1fa4c8ca` Proposals v2 (L6–L10, G1–G4, interactive tabs)
  - `375053f0` `?view=rebuild-demo` living demo
- Verification screenshots: `.screenshots/proposals-gallery/stitched-{proposals,v2}-verification.png`, `.screenshots/rebuild-demo/stitched-demo-verification.png` (gitignored)

## Progress

- [x] Recon: ratified rebuild model, current row/log rendering, hidden data inventory, per-workflow data diversity (4 Explore agents)
- [x] Proposal catalog + artifact mock
- [x] Gallery Proposals tab (`e623e16a`)
- [x] Group-scale + log-panel-v2 + interactive tabs (`1fa4c8ca`)
- [x] `?view=rebuild-demo` living demo (`375053f0`)
- [ ] **Operator keep/cut decisions on the 26 proposals + demo feedback** ← **resume here — blocked on the operator; walk them through `?view=rebuild-demo` and the gallery ledger part-by-part**
- [ ] Ratify survivors into `docs/rebuild/03-tracker-dashboard.md`: wire amendments (`facts[]`, `warnings {count, first}`, gate `label`, row-level `attempt`/`retryOfRunId`, `operatorChecked`), density-ladder rule, conveyor, L6–L10 surfaces, state-driven tab defaults — as a `docs(rebuild)` decision commit mirroring the D1–D5 style
- [ ] File the 4 correctness fixes (ledger bottom of Proposals tab): client `LogEntry` drops structured fields; client dedup clobbers server `count`; regex log categories vs structured `category`; reader-less `screenshotCount` — decide fix-now (current dashboard) vs fold-into-rebuild

## Open questions / deferred decisions

- Q: Which of the 26 proposals survive? — current thinking: only P5 (`retryOfRunId`) and G4 (`operatorChecked`) need new stamps; everything else is render-only or a small wire field, so the default lean is keep-most. V4 (day digest) is flagged "cut first if noise".
- Q: Do the 4 correctness fixes land in the CURRENT dashboard now or only in the rebuild? — not discussed with operator yet.
- Q: Demo screenshots are placeholder tiles (no real captures behind synthetic runs) — good enough for sign-off, or seed real PNGs?

## Verification before resuming

```bash
git status && git log --oneline -5
npm run typecheck:all
npm run test:architecture
npm run build:dashboard
# then look at the deliverables:
npm run dashboard   # → http://localhost:5173/?view=rebuild-demo  and  ?view=ui-gallery → Proposals tab
```

## Pointers

- CLAUDE.md: root `CLAUDE.md`; `src/dashboard/CLAUDE.md`; **`src/dashboard/components/CLAUDE.md`** (two 2026-07-24 lessons document the Proposals tab + rebuild-demo architecture — read these first)
- Rebuild docs: `docs/rebuild/03-tracker-dashboard.md` (ratification target), `docs/rebuild/reviews/second-look-2026-07-22.md` (D1–D5, 8 statuses, Log Panel strip, visual parity)
- Code: `src/dashboard/components/dev/proposals/` (toggle mocks + ledger), `src/dashboard/components/dev/rebuild-demo/` (`demo-data.ts` is the world model — the future implementation reference; delete both folders once real components ship)
- Memory: `rebuild-program-temp_src`, `orchestrator-subagent-design-process`, `prefers-interactive-mocks`
