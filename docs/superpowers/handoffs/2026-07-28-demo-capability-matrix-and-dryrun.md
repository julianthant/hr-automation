# Handoff — rebuild demo: capability matrix, dry-run correctness, and whatever the operator adds next

**Date:** 2026-07-28
**Paused at:** the 2026-07-27/28 redesign programme is **complete, verified and committed** (119 commits, local only). Two new operator decisions are **ratified but not implemented** — they are the starting work. **The operator will bring additional items into the new session alongside this brief; expect the scope to grow on arrival and treat this list as the floor, not the ceiling.**

## Task summary

`?view=rebuild-demo` is a **dev-only replica** of the future rebuilt HR-automation dashboard, and a *planning artifact*: the operator's standing framing is *"we practically need this mock/demo to look polished so we can include this in our rebuild plan because we need serious planning before we build the new rebuild or else it will have the same problems as before."* It is deleted once real components ship; production code must never import from `src/dashboard/components/dev/`.

The previous session ran ~16 waves against operator screenshot feedback and closed with a documentation pass. **The single most valuable output is `docs/rebuild/reviews/backend-capabilities-from-the-demo-2026-07-28.md`** — 18 things the backend must be *designed* to do, each discovered by building the frontend honestly and hitting a wall. That ledger is the reason the demo exists; keep adding to it as new frontend requirements expose new backend obligations.

## The two ratified-but-unbuilt decisions

### 1. A capability matrix surface — "which workflow has what, and what's missing"

Operator, verbatim: *"work study and kronos pay rule don't need a dry run yet. we should have those kind of stuff like marked in the settings or sth so we know which have which and which have what missing."*

So **`work-study` and `kronos-pay-rule` lacking dry run is ACCEPTED, not a defect.** What is missing is *visibility*: there is nowhere to see, per workflow, which capabilities it has and which it lacks.

Build a **read-only capability matrix** — Settings is the operator's suggested home ("or sth" leaves it open; Settings already has a read-only Status/Reference group that is the natural fit). Per workflow, show at least: dry run · roster · workers · presets · capture · duplicate check · multi-file/merge · sub-selections · member outcomes · startability (and by which methods) · delegation targets · whether it writes to a system of record.

Design constraints:
- **Derive it from the served descriptor**, never a hand-maintained table. Wave 10 put start capability on the descriptor (`start: StartCapabilityWire`) and wave 7 put `memberOutcomes` there; this surface reads the same registry the run modal and rail read, so it cannot drift. A hand-written matrix is the exact failure mode of the old catalog (see wave 16, defect 3).
- **"Missing" must be distinguishable from "not applicable."** `work-study` has no dry run *by decision*; `person-match` has no start path *because nothing calls it*. Those are different facts and the matrix must not flatten them into one blank cell. Consider a served reason on the absence.
- Read-only. No toggles — a capability is a property of the workflow, not a preference.
- Honour D24 (no explanatory prose; ⓘ or nothing) and the chip rules (bordered, matte, never wrap).

**Backend implication to add to the ledger:** the descriptor must serve *absences with reasons*, not merely omit fields — otherwise the frontend cannot tell "not built yet" from "does not apply."

### 2. Dry run must mean nothing is submitted — onboarding currently violates this

Operator, verbatim: *"onboarding should not create i9 during dry run. dry run means nothing gets submitted."*

The previous session found (grep-verified, recorded in §0 of the capability ledger) that **`onboarding` creates the I-9 profile even on a dry run** — its dry-run guard sits *after* `i9-creation`, and the code's own comment admits the I-9 create has already run by then.

This is a **correctness change to the real product**, not a demo change:
- The dry-run boundary for onboarding moves **before** `i9-creation`, so a rehearsal writes nothing anywhere.
- The rule to encode and enforce: **dry run means no system of record is written, at all, by any step.** Not "no *final* submit" — no write.
- Update `docs/rebuild/` wherever the onboarding boundary is described (the capability ledger §0 currently states the hazard; it becomes a resolved decision).
- Consider a guard: a workflow declaring dry-run support must have every write node below its boundary. That is mechanically checkable and would have caught this.
- Reflect it in the demo's Explorer graph for onboarding (the boundary node moves) — the Explorer already models `dryRunBoundaryNodeId` as optional and serves three postures (`boundary` / `no rehearsal` / `no system-of-record write`).

**Note the asymmetry:** `work-study` and `kronos-pay-rule` are fine *because they claim no dry run*. Onboarding is broken *because it claims one and doesn't honour it*. A capability that lies is worse than a capability that is absent — that is the through-line of both decisions.

## Current state

- Branch: `master`, local only. **Never push without explicit instruction.**
- Tip: `90f842dd`. **119 commits** landed this session (`066cb250..HEAD`).
- Worktrees: **none** (two were used and swept). One unrelated branch `worktree-agent-af8b23ed8fb094299` has unmerged commits touching `systems`/`ocr`/`separations` — **the operator's own work from an earlier session; do not delete or merge it.**
- **Gates:** `typecheck:all` clean · `lint` clean · `test:architecture` 137/137 · `build:dashboard` clean · `npm run test` **4561 passing, 1 failing**.

### The one failing test is the operator's, not the demo's

`tests/unit/tracker/tasks/ocr-continuation.test.ts > applyOcrActiveCheckContinuation flags inactive records for manual edit` asserts the OLD behaviour. The operator has an in-progress policy change ("inactive employees are submittable", 2026-07-27) in the uncommitted files below. **Do not fix that test** — it belongs to their work and will go green when they reconcile it.

### Thirteen uncommitted files are the operator's — leave them alone

```
 M src/dashboard/components/CLAUDE.md
 M src/dashboard/components/ocr/OcrReviewPane.tsx
 M src/dashboard/components/ocr/approval-selection.ts
 M src/services/ocr/eid-lookup-results.ts
 M src/services/ocr/forms/emergency-contact.ts
 M src/services/ocr/forms/oath.ts
 M tests/unit/dashboard/ocr/approval-selection.test.ts
 M tests/unit/services/ocr/forms/emergency-contact.test.ts
 M tests/unit/services/ocr/forms/oath.test.ts
 M tests/unit/workflows/ocr/eid-lookup-results.test.ts
 M .codex/hooks.json
?? .github/hooks/
?? docs/rebuild/reviews/testing-system-plan-2026-07-27.md   (330-line proposal awaiting their sign-off)
?? scripts/enqueue-onbase-all-from-session.ts
```

**Never `git add -A`. Stage explicit paths on every commit and verify what you staged afterwards.**

## Progress — the completed programme, for context

All verified against a running build at 1280×720, both themes, evidence in `.screenshots/`.

- [x] Theme pair — Graphite Warm dark / Paper Ink light, togglable; running/queued/cancelled hueless
- [x] Workflow panel floating / icon / sidebar; `All workflows` removed; grouped by the 8 real registry categories
- [x] Three-column detail region — chrome 190→117px, tab body 123–215→213–335px
- [x] Data left the tab set, merged with editing, stacked step→sub-step→value
- [x] ⓘ per queue row, derived from the row variant
- [x] One unified Run Modal, all workflows, descriptor-served sub-selections
- [x] Right-click context menu (`m` by keyboard); `⋯` removed
- [x] Equal-width timeline; wait renders on the current step's bar; queued runs draw outlined-empty
- [x] D11 collapsed to one member shape at every count
- [x] Settings 26 leaves → 8; Archive rebuilt as a virtualised table; Explorer three panels + all 16 graphs
- [x] Capture surface with mock sessions, pages on the right
- [x] One motion language in tokens
- [x] Verification pass — 43 checks, 2 partial, 8 defects found
- [x] Cleanup wave — all 8 defects fixed
- [x] Documentation — §9 amended (D5/D11/D12/D18/D19/D20/D21 revised, **D22–D24 ratified**), shell model, capability ledger, pending lesson
- [ ] **Capability matrix surface** ← resume here
- [ ] **Onboarding dry-run boundary fix**
- [ ] **Whatever the operator adds on arrival**

## Open questions / deferred decisions

- **Q: Where does the pending lesson land?** `docs/rebuild/reviews/pending-lesson-dashboard-components-2026-07-28.md` must be folded into `src/dashboard/components/CLAUDE.md`'s Lessons Learned once the operator's OCR work commits. It notes the 2026-07-24 and 2026-07-26 entries there are partly superseded.
- **Q: `DESIGN.md`'s status table still describes `Verified done`** as "green check, muted label" with `CheckCircle2`; the code renders label `Done`, green, no icon (D22). One-row fix when next touched.
- **Q: `docs/rebuild/12-operator-trust-and-authoring.md:284` and `03-tracker-dashboard.md:1276`** still say `Verified done` and need reconciling with D22.
- **Q: `demo-feature-plan-2026-07-25.md:229`** still lists "gate banner above tabs, duration-true timeline" as pending — both now reversed (D18, D21). Ephemeral-tier doc; noted, not edited.
- **Carried from earlier, still unresolved:** are writes editable in the merged Data tab (current: visible, never editable — the one D19 sub-clause without a real decision); should one failed member promote a whole group to `Failed`; fix the live production-dashboard bugs now or only in the rebuild; when do OCR review edits stop being browser state.

## Verification before resuming

```bash
git status && git log --oneline -5
npm run typecheck:all
npx eslint src/dashboard/components/dev --ext .ts,.tsx
npm run test:architecture      # 137 expected
npm run test                   # 4561 pass, 1 fail — the operator's ocr-continuation test ONLY
npm run build:dashboard
```

Then **boot it and drive it** — this is not optional:

```bash
npm run build:dashboard
HRAUTO_TRACKER_DIR=generated/.dashboard-preview/tracker npm run dashboard:prod -- --port 3941
#   http://localhost:3941/?view=rebuild-demo
```

**Port 3838 is the operator's own dashboard — never touch it.** After `build:dashboard` you MUST restart the server and `playwright-cli close`, or you screenshot a stale bundle.

### Hard-won gotchas — read these before you start

- **Four waves shipped defects that only BOOTING caught and typecheck did not:** twice a fixture holding a formatted clock string where a demo instant was required (one crashed the panel on every save); a Radix `Tooltip` with no `TooltipProvider`, thrown and swallowed by the error boundary so the page went blank; a Popover that teleported the toast viewport across the window. **Typecheck is not verification.**
- **A "failed: stalled" agent notification was WRONG** — the agent was still writing. Relaunching put two agents on one tree. Verify an agent is actually dead before relaunching.
- **A `git checkout` used to build a comparison screenshot discarded four uncommitted files.** Never `checkout`/`stash`/`reset` this shared tree.
- **Port `N+1` is not free** — an agent's phone-capture sidecar binds `port + 1`, so consecutive ports collide across parallel agents.
- **A worktree has no `.env`**, so `dashboard:prod` dies there immediately.
- **A design-system fix half-lands by default.** `Chip`, `Well` and the row footer were migrated correctly while nine hand-rolled chips and four structural twins were not. When you fix a primitive, sweep its hand-rolled siblings.

## Pointers

- **Read first:** `src/dashboard/components/dev/rebuild-demo/DESIGN.md` — binding, updated through wave 16. Then `src/dashboard/components/CLAUDE.md` (its 2026-07-26 lessons, partly superseded by the pending lesson above).
- **The key artefact:** `docs/rebuild/reviews/backend-capabilities-from-the-demo-2026-07-28.md` — 18 backend obligations + §0's two live-product hazards. **Add to it as new requirements surface.**
- **Decisions, inviolable:** `docs/rebuild/03-tracker-dashboard.md` §9 = **D6–D24**.
- **Visual parity is ratified:** `docs/rebuild/reviews/second-look-2026-07-22.md` §6.6. Refinement, not redesign.
- **Prior handoff (superseded):** `docs/superpowers/handoffs/2026-07-27-demo-layout-declutter.md`.
- **Code:** `src/dashboard/components/dev/rebuild-demo/` — `demo-wire.ts` is the contract, `demo-data.ts` the fixtures + projection, `demo-catalog.ts` the naming layer, `ds/` the design system.
- **Memory:** `rebuild-program-temp-src` (updated 2026-07-28 with this programme), `orchestrator-subagent-design-process`, `prefers-interactive-mocks`, `screenshot-chunks-stitch-into-one`, `fail-loud-no-unverified-fallbacks`.
- **Working style:** the operator prefers a lean orchestrator with subagents doing the heavy work, plain-language part-by-part sign-off, and `/custom-ui` handed to any agent building frontend. They give feedback as screenshots — expect many, in batches. **One writer per tree at a time**; use worktrees for genuine parallelism and merge them yourself.
