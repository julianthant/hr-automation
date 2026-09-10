# Handoff — rebuild frontend: replica demo, named UI catalog, design ledgers

**Date:** 2026-07-25
**Paused at:** all design + demo work built, verified and committed. **Blocked on operator decisions** before anything is ratified into `docs/rebuild/03-tracker-dashboard.md`.

## Task summary

Part of the **rebuild program** (memory: `rebuild-program-temp-src`). The operator's framing: *"we practically need this mock/demo to look polished so we can include this in our rebuild plan because we need serious planning before we build the new rebuild or else it will have the same problems as before."* So this session turned `?view=rebuild-demo` from a two-panel mock into a **full replica dashboard**, rebuilt `?view=ui-gallery` into a **named specimen catalog**, and produced three code-grounded design ledgers so the rebuild's frontend is *planned* rather than rediscovered.

The load-bearing constraint behind most decisions: this is a single-operator tool that files **real HR transactions**, and the operator reviews each person before approving. That is why the per-person review surface exists, why Approve is gated on having actually looked at every record, and why nothing is fabricated in the timeline.

## Plan

No superpowers plan file — this was operator-directed design work following the rebuild working style (memory: `orchestrator-subagent-design-process`: lean orchestrator, plain-language part-by-part sign-off). The "plan" is the decision queue in **Open questions** below.

## Current state

- Branch: `master`, local only. **Never push without explicit instruction.**
- Worktrees: none (the stale i9 worktree noted in older handoffs is gone).
- Commits this session (8, all verified):
  - `95c14a7b` packet-at-approval world model + named row/panel catalog
  - `3e02cef9` Log Panel tabs derive from the panel kind
  - `e829a39f` full replica shell — Top Bar, Workflow Panel, Status Bar, Session Panel
  - `312b7857` three design ledgers (docs)
  - `61cc6f2c` shell fidelity pass against the build spec
  - `9022c124` dashboard CLAUDE.md lesson + corrected a stale tile lesson
  - `e15677b3` UI gallery rebuilt as a named specimen catalog; `dev/proposals/` retired
  - `a5ac5475` real timeline, merged Data tab, tidier evidence + session cards
- Uncommitted: **not ours** — `.codex/hooks.json` modified plus ~20 untracked `.agents/skills/*` dirs and `skills-lock.json` came from a skills install during the session. Leave them alone. A pre-existing `stash@{0}` is also not ours.
- Verification screenshots (gitignored): `.screenshots/rebuild-demo-v2/stitched-walkthrough.png`, `.screenshots/ui-catalog/0{1..7}-*.png`

## What exists now

**`?view=rebuild-demo`** — full replica: Top Bar, Workflow Panel (200px rail, amber queued sub-badge), Status Bar (7 pills), Queue Panel, Log Panel, Session Panel (5 cards, every browser-health state, right-click recovery menu). `countRows()` in `DemoShell.tsx` is the **single counting path** feeding rail badges + pills + queue, which makes the standing "badges always error out" complaint unrepresentable. Second view: **Row & panel catalog**.

**`?view=ui-gallery`** — named specimen catalog, 4 tabs (Queue Rows · Log Panels · Session Cards · Controls). Renders the *demo's* components so the catalog can't drift.

**Design decisions built into the demo** (all operator-directed):
- Tabs derive from the **panel kind**, not a fixed five: Run 3 · Review 4 · Group 4 · Member 3.
- **Screenshots is not a tab** — an evidence bar of images sits above the tabs (no count label; a failure capture carries a red frame).
- **Review exists only on the OCR Review Run Row.** Every other row's decision is a gate banner pinned above the tabs.
- **Data and Edit Data are ONE surface** — every value the run touched, reads editable in place, footer offers `Load a prior run` / `Start a run from this data`. Writes are shown but not editable.
- The step pill strip + progress bar were replaced by **one timeline** where each segment's width is its real recorded duration, with the gate wait as a hatched segment.
- **8 named row variants** over the 3 ratified types, **4 Log Panel kinds** — derived by `rowVariantOf`/`panelKindOf`, nothing new stamped.

## Progress

- [x] Audit today's rows + log panel → `docs/rebuild/reviews/legacy-keep-ditch-2026-07-25.md`
- [x] Delegation topology + layouts → `docs/rebuild/reviews/delegation-layouts-2026-07-25.md`
- [x] Shell build spec → `docs/rebuild/reviews/shell-build-spec-2026-07-25.md`
- [x] Name row variants + panel kinds (`demo-catalog.ts`, live catalog view)
- [x] Per-person review flow (packet at approval + delegated OCR Review Row)
- [x] Replica shell + operator corrections (timeline, merged Data, evidence, session cards)
- [x] UI gallery rebuilt as specimen catalog; `dev/proposals/` deleted
- [ ] **Operator answers to the 12 delegation questions** ← **resume here**
- [ ] Ratify survivors into `docs/rebuild/03-tracker-dashboard.md` as a `docs(rebuild)` decision commit mirroring the D1–D5 style
- [ ] Decide fix-now vs fold-into-rebuild for the live bugs the audit found in the CURRENT dashboard

## Open questions / deferred decisions

**The 12 delegation questions** — `delegation-layouts-2026-07-25.md` §7, each with a recommendation. Highest-stakes:
- Q1: should oath-upload's signer rows disappear from the Oath Signature panel and live only inside the Oath Upload packet group? (recommend yes — double-listing is the count-divergence bug class)
- Q6: at what member count does the matrix replace the list? (recommend 41; the demo currently switches at **20** — pick one and make them agree)
- Q8: when a linked OCR child fails, is the parent `Failed` or `Waiting on you`? (recommend Failed + a Re-upload action)
- Q10: `person-match` has zero callers — hide it from the Workflow Panel?

**Writes not editable in the merged Data tab** — my judgement call: what a run put into UCPath is a record of what happened, not a form. Staged writes are visible with `staged` chips; the way to change them is to edit the reads they derive from and start a new run. Operator has not confirmed.

**The gallery no longer covers today's production components.** It used to render the real `EntryItem` / `WorkflowBox`, so design regressions in the *current* dashboard showed up there. It now renders the rebuild's components. Offered to add a thin "current dashboard" tab back; no answer yet.

**Live bugs in the CURRENT dashboard** found during the audit (`legacy-keep-ditch-2026-07-25.md` §3) — none fixed, all documented: the I-9 doc-kind chip never renders; `addBlankRow` injects an EC-shaped record into i9 runs; the record footer chip discards `tracker.label`; Edit Data can block Save with nothing highlighted; screenshot `refreshKey` is a count not a nonce; `runNumber` returns 0; `copyTrace` toasts success unconditionally; `FailedPageCard.onRetryComplete` never passed. Plus fail-loud violations on the OCR approve path (corrupt localStorage reads as "no edits"). **Decide: fix now in the legacy tree, or only in the rebuild?**

**Structural finding worth acting on:** all OCR review edits and record removals live only in `localStorage` keyed by run. Another browser sees un-edited records and "Re-OCR whole PDF" wipes them with no undo. This collides with the ratified multi-user seams — **review edits must be commands against the run, not browser state.**

## Verification before resuming

```bash
git status && git log --oneline -8
npm run typecheck:all
npm run test:architecture      # 137 expected
npx eslint src/dashboard/components/dev --ext .ts,.tsx
npm run build:dashboard
```

Then look at the deliverables (the demo is dev-only, no daemon or tracker data needed):

```bash
npm run build:dashboard
HRAUTO_TRACKER_DIR=generated/.dashboard-preview/tracker npm run dashboard:prod -- --port 3941
#   http://localhost:3941/?view=rebuild-demo   → Dashboard | Row & panel catalog
#   http://localhost:3941/?view=ui-gallery     → Queue Rows | Log Panels | Session Cards | Controls
```

Sweep afterwards: `playwright-cli close-all` and kill the port-3941 server. `:3838` is the operator's own dashboard — never kill it.

## Pointers

- CLAUDE.md: root; `src/dashboard/CLAUDE.md`; **`src/dashboard/components/CLAUDE.md`** — the 2026-07-25 lesson documents the whole demo/catalog architecture and the three gotchas hit building it. Read that first.
- Rebuild docs: `docs/rebuild/03-tracker-dashboard.md` (ratification target), `docs/rebuild/reviews/second-look-2026-07-22.md` §6.6 (D1–D5, the 8 statuses, the naming canon, the visual-parity directive), plus this session's three ledgers in `docs/rebuild/reviews/*-2026-07-25.md`.
- Code: `src/dashboard/components/dev/rebuild-demo/` — `demo-data.ts` is the world model, `demo-catalog.ts` the naming layer, `demo-status.tsx` the 8 statuses, `DemoLogPanel/DemoQueue/DemoShell` the surfaces. `dev/UiGallery.tsx` is the catalog. Delete both folders once real components ship; never import them from production code.
- Memory: `rebuild-program-temp-src`, `orchestrator-subagent-design-process`, `rebuild-write-safety-gap-audit`, `prefers-interactive-mocks`, `screenshot-chunks-stitch-into-one`.
- Prior handoff (superseded by this one): `docs/superpowers/handoffs/2026-07-25-queue-log-panel-proposals-demo.md` — note its "26 proposals" decision surface no longer exists; `dev/proposals/` was deleted, the survivors are built.
