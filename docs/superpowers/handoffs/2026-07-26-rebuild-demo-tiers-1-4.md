# Handoff — rebuild frontend: demo Tiers 1–4 built, D6–D20 ratified, four open items before implementation

**Date:** 2026-07-26
**Paused at:** all four tiers of the demo build plan shipped and verified; the 12 delegation questions
+ 3 build-gating decisions ratified. **Not blocked on operator decisions** the way the prior handoff
was — the delegation questions are answered — but four open items (below) still need a call before
real components ship.

## Task summary

Continuation of the **rebuild program** (memory: `rebuild-program-temp-src`). The prior handoff
(`2026-07-25-rebuild-replica-demo-ui-catalog.md`) left the demo as a full replica dashboard with a
named row/panel catalog, blocked on 12 delegation questions. Since then: the operator ratified those
questions (plus 3 build-gating decisions) into `docs/rebuild/03-tracker-dashboard.md` §9 as **D6–D20**,
and roughly ten subagents built the demo out across all four tiers of
`docs/rebuild/reviews/demo-feature-plan-2026-07-25.md`, each on its own feature branch, merged to
master in sequence. The demo (`?view=rebuild-demo`) is a **planning artifact** — it is deleted once
real components ship, and production code must never import from
`src/dashboard/components/dev/rebuild-demo/`.

## Plan

No superpowers plan file — same operator-directed working style as the prior handoff (memory:
`orchestrator-subagent-design-process`: lean orchestrator, Fable-high subagent brainstorms,
plain-language part-by-part sign-off). The "plan" was the tier build order in
`demo-feature-plan-2026-07-25.md`; the decision queue was the 12 delegation questions +
3 build-gating decisions, now closed (see below).

## Current state

- Branch: `master`, local only. **Never push without explicit instruction.** `git status` shows the
  branch 94 commits ahead of `origin/master`.
- Worktrees: none (`git worktree list` shows only the main tree). Branches: none (`git branch --list
  'feature/*'` is empty) — every feature branch below was merged `--no-ff` and deleted per the
  worktree-discipline rule.
- **Ratification commit:** `6a80439a` — `docs(rebuild): ratify the 12 delegation decisions +
  tab/status-bar model into doc 03`. Writes D6–D20 into `docs/rebuild/03-tracker-dashboard.md` §9.
- **Tier build merges** (`--no-ff`, in order), each followed by its own `docs(dashboard): record the
  … lesson` commit into `src/dashboard/components/CLAUDE.md`:
  - `075723b9` Merge feature/designsys — design-system tokens, primitives, the builder brief
  - `dac4061e` Merge feature/wire — the demo world model IS the wire contract (Tier 1)
  - `8c068d3d` Merge feature/runstart — Run Modal, typed input runs, the spreadsheet intake pipeline
  - `d2e85161` Merge feature/queue2 — the four missing delegation shapes, ladder rungs, run identity,
    bulk actions (Tier 2)
  - `fd6c4909` Merge feature/flows — notifications, search, date navigation, park resolution, the
    real Data tab
  - `0240fd8c` Merge feature/trust — full receipts, failure records, evidence lightbox, toast/dialog
    fix (Tier 4a)
  - `2d5e6ca9` Merge feature/periphery — settings provenance, storage health, archive-on-version-bump,
    explorer, activity report (Tier 4b)
  - `496f8189` Merge feature/polish-core — one status table, tokenised rhythm, a readable shell
  - `40fd6fc9` Merge feature/polish-new — unified refusals, meta lines, page headers across the newer
    surfaces
  - `dcbc007d` fix(rebuild-demo): the confirm dialog registers modal presence (closes the one
    outstanding item the toast/dialog fix left open)
- **This cleanup pass (2026-07-26):** de-duplicated the six 2026-07-26-dated lessons in
  `src/dashboard/components/CLAUDE.md` (they independently re-explained the wire contract, the TDZ
  module-ordering gotcha, and the `dashboard:prod` boot-cache gotcha) into six tightened entries with
  cross-references instead of repetition, folded the now-resolved toast/modal-presence lesson into the
  polish-pass entry, and corrected one now-false claim in the 2026-07-24 Proposals-tab lesson (it
  quoted a 20+ member-count matrix threshold; D11 ratified **41+**). This file replaces the stale
  2026-07-25 handoff. Committed together with the CLAUDE.md edit — see the top-level commit log for
  the exact SHA.
- **Uncommitted, not ours, leave alone:** `.codex/hooks.json` (modified) and `.github/hooks/`
  (untracked, one file `impeccable.json`) — both pre-date this session's work and are unrelated tooling
  artifacts. A pre-existing `stash@{0}` (`WIP on master: 67a913bb …`) is also not ours.
- **Uncommitted, IS demo code, needs a decision:** `src/dashboard/components/dev/rebuild-demo/DESIGN.md`
  and `ds/primitives-overlay.tsx` carry an in-progress, **undocumented** enhancement — a `danger` toast
  now recedes to a one-line chip after ~6s instead of holding the full card forever (hover/press brings
  it back; `data-ds-toast-state="full"|"chip"` is the new hook). This is not part of Tiers 1–4, has no
  CLAUDE.md lesson, and is not committed. Decide whether to finish + commit + document it, or discard it,
  before treating the working tree as clean.

## What exists now

`?view=rebuild-demo` has three views (switcher, not a rail — 44px bar, 3 entries):
- **Dashboard** — the full replica shell (Top Bar with real notifications/search/date-nav, Workflow
  Panel, Status Bar, Queue Panel, Log Panel, Session Panel with capacity/lanes), plus a Run Modal +
  Input Run Panel + six-stage spreadsheet intake mounted under the Status Bar, plus a bulk-command bar
  over multi-select.
- **Row & panel catalog** — the named specimen catalog (8 row variants, 4 Log Panel kinds).
- **Design system** — `DemoUiKit`, the third view-switcher entry; every `ds/` primitive on one page,
  per `DESIGN.md`'s instruction to skim it before building a component.

Every row's controls derive from its served `actions[]` (`demo-wire.ts` / `DemoActions.tsx`) — there is
no `status === "x" ? <Button/>` anywhere in the demo. Commands go through `demo-commands.ts` /
`demo-runstart-wire.ts`, both returning the same `applied | conflict | rejected` union, with a real
reachable CAS conflict (`ws-priya`, v3 vs v5) and a real reachable refusal (retrying an
11-of-12-signed `oath-batch`). Full `RunEvidenceReceipt` / `FailureRecord` / evidence lightbox render
from a fetch-by-id trust store (`demo-evidence-wire.ts`). Settings, storage health,
archive-on-version-bump, the read-only Explorer, and the activity report are all served from their own
wire modules under Settings' "Full-page views" nav group. Three shared `ds` shapes (`Refusal`,
`MetaLine`, `BulletList`) now back every surface that declines, shows provenance, or lists facts.

## Progress

- [x] 12 delegation questions + 3 build-gating decisions ratified as D6–D20 (`6a80439a`)
- [x] Tier 1 — wire contract, `actions[]`-derived controls, command service (conflict/rejected)
- [x] Tier 2 — the four missing delegation shapes (S1/S5/S6/S7), run identity + attempt lineage, bulk
- [x] Run-start half — Run Modal, typed input runs, six-stage spreadsheet intake
- [x] Notifications, search, date navigation, write-park resolution, the real merged Data tab
- [x] Tier 4a — full receipts, failure records, evidence lightbox
- [x] Tier 4b — settings provenance, storage health, archive-on-version-bump, session-card capacity,
      read-only explorer, activity report
- [x] Two `/custom-ui`-style polish passes — shared shapes, toast/dialog fix, page headers
- [x] De-duplicate the six 2026-07-26 CLAUDE.md lessons; correct the stale 20+ matrix-threshold claim
- [ ] **Decide the four open items below** ← resume here
- [ ] Decide fix-now vs fold-into-rebuild for the live bugs in the CURRENT production dashboard
- [ ] Decide whether to finish/commit/document the in-progress toast-recede-to-chip enhancement, or
      discard it
- [ ] When real implementation starts: port demo surfaces into production components, then delete
      `dev/rebuild-demo/` and `dev/UiGallery.tsx`

## Open questions / deferred decisions

1. **Writes are visible but not editable in the merged Data tab (D19) — still not confirmed by the
   operator.** Flagged twice across two different sessions, never contested either time. Treat as a
   standing assumption, not a ratified decision, until the operator explicitly signs off.

2. **The ratified rollup precedence, applied literally, means one failed member promotes a whole group
   to `Failed`.** Concretely: `oath-batch` reads `Failed` while holding 11 verified signers out of 12.
   This is the precedence working exactly as written (D9's "an unrun person is not a finished person"
   logic extended to failures) — **changing it would be a decision change, not a bug fix.** Don't "fix"
   this without a new decision.

3. **The live bugs in the CURRENT production dashboard**, found by the earlier audit
   (`docs/rebuild/reviews/legacy-keep-ditch-2026-07-25.md` §3), are still undecided: fix now in the
   legacy tree, or only in the rebuild. List unchanged since the prior handoff: the I-9 doc-kind chip
   never renders; `addBlankRow` injects an EC-shaped record into i9 runs; the record footer chip
   discards `tracker.label`; Edit Data can block Save with nothing highlighted; screenshot `refreshKey`
   is a count not a nonce; `runNumber` returns 0; `copyTrace` toasts success unconditionally;
   `FailedPageCard.onRetryComplete` never passed; plus fail-loud violations on the OCR approve path
   (corrupt localStorage reads as "no edits").

4. **OCR review edits + record removals still live only in `localStorage` keyed by run** — collides
   with the ratified multi-user seams from D6–D20 (another browser sees un-edited records; "Re-OCR
   whole PDF" wipes them with no undo). **Review edits must become commands against the run**, not
   browser state. Not yet started.

## Verification before resuming

```bash
git status && git log --oneline -12
npm run typecheck:all
npx eslint src/dashboard/components/dev --ext .ts,.tsx
npm run build:dashboard
npm run test:architecture      # 137 expected
```

Then look at the deliverable:

```bash
HRAUTO_TRACKER_DIR=generated/.dashboard-preview/tracker npm run dashboard:prod -- --port 3941
#   http://localhost:3941/?view=rebuild-demo   → Dashboard | Row & panel catalog | Design system
```

Sweep afterwards: `playwright-cli close-all` and kill the port-3941 server. **`:3838` is the operator's
own dashboard — never touch it.**

## Pointers

- CLAUDE.md: root; `src/dashboard/CLAUDE.md`; **`src/dashboard/components/CLAUDE.md`** — six
  2026-07-26 lessons (design-system + wire contract / Tier 1, the four delegation shapes + run
  identity + bulk / Tier 2, the run-start half, Tier 4a trust surfaces, Tier 4b periphery, and the two
  polish passes incl. the toast/modal-presence fix), de-duplicated this session. Read that first.
- Rebuild docs: `docs/rebuild/03-tracker-dashboard.md` §9 (D6–D20, the ratification this handoff is
  built on) and §10 (Round-8 obligations); `docs/rebuild/reviews/demo-feature-plan-2026-07-25.md` (the
  4-tier build plan every commit above cites); `docs/rebuild/reviews/delegation-layouts-2026-07-25.md`
  (the original 12 questions, now superseded by D6–D17 where they disagree);
  `docs/rebuild/reviews/legacy-keep-ditch-2026-07-25.md` §3 (the live-bug list, open item 3 above);
  `docs/rebuild/reviews/second-look-2026-07-22.md` §6.6 (D1–D5, the row-model series D6–D20 continues).
- Code: `src/dashboard/components/dev/rebuild-demo/` — `DESIGN.md` (binding brief, read before adding a
  component), `demo-wire.ts` (core wire contract), `demo-runstart-wire.ts` (enqueue half),
  `demo-evidence-wire.ts` (trust half), `demo-data.ts` / `demo-catalog.ts` (fixtures + naming),
  `demo-commands.ts` (command service), `ds/` (design-system primitives — `primitives-overlay.tsx` has
  the in-progress toast-recede change from "Current state" above), `Demo*.tsx` (surfaces). `dev/
  UiGallery.tsx` is the older specimen catalog. **Delete both folders once real components ship; never
  import from them in production code.**
- Memory: `rebuild-program-temp-src`, `orchestrator-subagent-design-process`,
  `rebuild-write-safety-gap-audit`, `prefers-interactive-mocks`, `screenshot-chunks-stitch-into-one`.
- Prior handoff (superseded by this one): `docs/superpowers/handoffs/2026-07-25-rebuild-replica-demo-ui-catalog.md`
  — its "12 delegation questions" are answered (D6–D20); its "live bugs" and "writes not editable" open
  items carry forward unchanged (items 1 and 3 above).
