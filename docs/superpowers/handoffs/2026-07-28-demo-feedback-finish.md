# Handoff — rebuild demo: finish operator feedback wave + verify

**Date:** 2026-07-28
**Paused at:** mid-execution. Production onboarding dry-run is fixed (uncommitted). A large uncommitted rebuild-demo frontend delta (~2k lines) already implements most of the 20 feedback items + capability matrix + Explorer boundary, but **it has not been typechecked as a green gate, boot-verified, or screenshot-compared**. Resume by finishing the PARTIAL items, running gates, then booting and verifying against the operator screenshots.

## Task summary

`?view=rebuild-demo` is the planning artifact for the rebuilt HR-automation dashboard. The operator delivered 20 screenshot-driven polish/correctness items (numbered 1–13, 15–20 — **14 was skipped on purpose**) plus two ratified-but-unbuilt decisions from the prior handoff: a descriptor-derived **capability matrix**, and fixing **onboarding's dry-run boundary** so a rehearsal writes nothing.

Motivation: the demo must be polished enough to plan the rebuild from; a capability that *lies* (onboarding claiming dry-run while creating I-9 profiles) is worse than a capability that is absent (`work-study` / `kronos-pay-rule` by decision). The frontend wave also exposed that many “visual” asks are really shared-primitive / redundancy / geometry problems — fix them as themes, not twenty patches.

## Plan

- Operator brief (binding inventory of all 20 items + screenshots): `docs/rebuild/reviews/operator-feedback-2026-07-28-screenshots.md`
- Screenshots (gitignored, local): `.screenshots/operator-feedback-2026-07-28/`
- Prior floor handoff (superseded by this one for resume): `docs/superpowers/handoffs/2026-07-28-demo-capability-matrix-and-dryrun.md`
- Binding design: `src/dashboard/components/dev/rebuild-demo/DESIGN.md`
- Capability ledger (add to it as new walls appear): `docs/rebuild/reviews/backend-capabilities-from-the-demo-2026-07-28.md`
- No separate `superpowers` implementation-plan file — the brief + this handoff *are* the plan.

## Current state

- Branch: `master` (local only). **Never push without explicit instruction.**
- Tip commit: `90f842dd` (215 commits ahead of `origin/master`).
- Worktrees: **none**.
- Uncommitted work is a MIX of three ownerships — treat them separately:

### A. This wave — product dry-run (Sol, ready to commit once schema JSDoc is fixed)

```
 M src/workflows/onboarding/workflow.ts
 M src/workflows/onboarding/CLAUDE.md
 M tests/unit/workflows/onboarding/workflow.test.ts
 M docs/rebuild/reviews/backend-capabilities-from-the-demo-2026-07-28.md
```

What landed: dry-run returns **before** `i9-creation` (and therefore before Smart HR). Stamps `status: "Dry Run Complete"`, `dryRun: true`, `i9ProfileId: "Not created — dry run"`. Screenshot label `onboarding-dry-run-before-writes`. Unit test pins boundary before both mutation sites. Ledger §0.2 marked RESOLVED.

**Stale leftover:** `src/workflows/onboarding/schema.ts` JSDoc still says I-9 create runs on dry run — fix before committing.

### B. This wave — rebuild-demo frontend (large uncommitted delta, mostly implemented, UNVERIFIED)

~2008 insertions / 357 deletions across:

```
 M src/dashboard/components/dev/rebuild-demo/Demo{Actions,ActivityReport,Evidence,LogPanel,Queue,RunStart,Settings,Shell}.tsx
 M src/dashboard/components/dev/rebuild-demo/RebuildDemo.tsx
 M src/dashboard/components/dev/rebuild-demo/demo-{archive,data,evidence,explorer,wire,workers}-wire.ts / demo-data.ts / demo-wire.ts
 M src/dashboard/components/dev/rebuild-demo/ds/{primitives-core,primitives-overlay}.tsx
 M src/dashboard/components/dev/rebuild-demo/ds/tokens.css
 M src/dashboard/components/dev/UiGallery.tsx
 M tests/unit/dashboard/rebuild-demo-archive.test.ts
?? src/dashboard/components/dev/rebuild-demo/demo-capability-wire.ts
?? src/dashboard/components/dev/rebuild-demo/demo-nav-history.ts
?? tests/unit/dashboard/rebuild-demo-capability.test.ts
?? docs/rebuild/reviews/operator-feedback-2026-07-28-screenshots.md
```

### C. Operator's own OCR work — **LEAVE ALONE. Never stage.**

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
?? docs/rebuild/reviews/testing-system-plan-2026-07-27.md
?? scripts/enqueue-onbase-all-from-session.ts
```

Also do **not** delete/merge the unrelated branch `worktree-agent-af8b23ed8fb094299` (operator's earlier systems/ocr/separations work).

**Never `git add -A`. Stage explicit paths and verify the index after every commit.**

## Ratified decisions (do not re-ask)

| # | Decision |
|---|---|
| 9 | Remove the eye glyph. Rail shows `queued+running \| total` (e.g. `3 \| 8`). Not a Needs-you count. |
| 13 | Formalize **separate** app `major.minor` and per-workflow `major.minor`. Trace IDs correlate runs; they are never the only source of version semantics. |
| 4 | Remove “Waiting for you” **only from the pictured session card**. Keep actionable Waiting-on-you status + elapsed age elsewhere (queue / log panel / outcome bar). |
| 5 | Use `data/` only to **derive redacted/synthetic** demo records. Never commit, serve, or expose raw PII. Do not add raw files under `data/`. |
| A | Capability matrix lives in Settings Status/Reference. Derive from served descriptors. Absences carry reasons. Distinguish available / missing / not-applicable. Read-only. |
| B | Dry run = **no system-of-record write at all**. Onboarding boundary is before I-9 creation. |

## Progress

### Product correctness

- [x] Onboarding dry-run boundary moved before `i9-creation` (uncommitted; test green when last run)
- [x] Onboarding `CLAUDE.md` + capability ledger §0.2 updated
- [ ] Fix stale `schema.ts` JSDoc ← do before commit 1
- [ ] Commit product dry-run (explicit paths only)

### Feedback items — code present vs verified

Inventory from code evidence (not boot). **Resume by finishing PARTIALs, then verify everything.**

- [x] **1** Selected surface closer to resting (`--ds-surface-selected` 3%/4% mix) — code present, **needs visual verify**
- [x] **2** Member well restyle + expand to 20 + scroll — `PersonWell` / `MEMBER_WELL_OPEN_LINES=20` — **needs visual verify**
- [x] **3** Chip border + matte fill — `CHIP_TONE` / sibling sweep — **needs visual verify**
- [x] **4** Session-card / detail-header waiting chip removed; age on outcome bar
- [ ] **5** Evidence lightbox / WHAT WAS RECORDED — **PARTIAL** ← **resume here**
  - Present: `demo-evidence-wire.ts` synthetic `DemoPageFacsimile` / `oathFacsimile`; `DemoEvidence.tsx` `PageFacsimile` redesign
  - Missing: fallbacks still say “Image bytes are not in this corpus”; review pane still glyph placeholder (ties to 10)
- [x] **6** Toast vs DecisionNotice coordinate spaces decoupled (`RebuildDemo` toast floor = Session bar; notice bottom-left)
- [x] **7** UCPath capacity is session-scoped; Add-workers “will be refused” footer removed
  - **Stale test:** `rebuild-demo-worker-spawn.test.ts` may still assert old reason `"ucpath allows 1 concurrent session"`
- [x] **8** Evidence section denser (full-width list + well) — **needs visual verify**
- [x] **9** Rail `active \| total`; eye removed
- [ ] **10** Review pane fills max space — **PARTIAL**
  - Present: page aspect token
  - Missing: no `PageFacsimile` in review left column; still `"Page N — source image"` glyph; body does not flex-grow to kill dead space
- [x] **11** Back/forward nav history (`demo-nav-history.ts` + shell controls) — **no unit test yet**
- [ ] **12** Collapsed panel sliver / overall alignment — **PARTIAL / likely unfinished**
  - Floating/icon/sidebar modes exist; no clear wave fix for ~60px text-sliver collapse or global alignment sweep
- [x] **13** App `major.minor` formalized (`DEMO_APP_VERSION_PARTS`, archive change records, status bar)
- [ ] **14** *(skipped by operator numbering — not a task)*
- [ ] **15** Enclosed title/subtitle contrast + symmetric padding — **PARTIAL**
  - `PanelHeader` already title vs meta; `ds/primitives-layout.tsx` **not in the delta** — pictured Settings General row likely still wrong
- [x] **16** Activity day picker promoted; Settings + keyboard icon removed from Activity chrome
- [x] **17** “Back to the dashboard” removed from Activity only
- [x] **18** Toolbar height unified (`--ds-h-toolbar` → `--ds-h-md`, Button `size:"toolbar"`) — **needs visual verify**
- [x] **19** Outcome “Retry the lookup” removed; footer retry remains
- [x] **20** Parked footer ✕ restored; header Write-parked chip removed; duplicate Resolve omitted via `PANEL_OMITS_OUTCOME_ACTIONS`
- [x] **A** Capability matrix — `demo-capability-wire.ts` + Settings `CapabilitiesSection` + `rebuild-demo-capability.test.ts`
- [x] **B** Explorer onboarding graph — `dryRunBoundaryNodeId: "I-9 creation"`; I-9 + SmartHR `skippedInDryRun: true`

### Verification / ship

- [ ] Finish PARTIALs 5 / 10 / 12 / 15
- [ ] Fix stale seams (onboarding `schema.ts` JSDoc; worker-spawn test copy; optionally pin nav-history / rail counts / member-well)
- [ ] Gates green: typecheck · demo eslint · architecture 137 · targeted rebuild-demo + onboarding tests · `build:dashboard`
- [ ] Boot on **:3941** (never :3838), screenshot both themes, compare to `.screenshots/operator-feedback-2026-07-28/`
- [ ] Commit demo wave with explicit paths only
- [ ] Update capability ledger if new backend walls appear while finishing

## Open questions / deferred decisions

None left from the ratified set. Residual **engineering** choices only (decide while implementing, do not re-litigate product):

- Q: Must phone `DemoCapture` also get facsimiles, or is evidence + OCR review enough for item 5/10?
- Q: How far does item 12's “overall alignment” sweep extend beyond fixing the collapsed-panel min-width / sliver?
- Q: Where does `docs/rebuild/reviews/pending-lesson-dashboard-components-2026-07-28.md` fold into `src/dashboard/components/CLAUDE.md`? — deferred until the operator's OCR work commits (carry from prior handoff).

Prior handoff's open doc drifts still unresolved (touch when next nearby): `DESIGN.md` Verified-done vs D22; `docs/rebuild/12-…` / `03-…` Verified-done wording; ephemeral `demo-feature-plan-2026-07-25.md:229`.

## Verification before resuming

```bash
git status
git log --oneline -5
# Confirm tip is still 90f842dd (or note if you committed since)

# Product dry-run still correct:
npx vitest run tests/unit/workflows/onboarding/workflow.test.ts --reporter=verbose

# Capability matrix pure seam (new file):
npx vitest run tests/unit/dashboard/rebuild-demo-capability.test.ts --reporter=verbose

# Likely stale — expect failure or update:
npx vitest run tests/unit/dashboard/rebuild-demo-worker-spawn.test.ts --reporter=verbose

npm run typecheck:all
npx eslint src/dashboard/components/dev --ext .ts,.tsx
npm run test:architecture   # 137 expected
npm run build:dashboard
```

Then **boot it** (typecheck is not verification — prior waves shipped defects only boot caught):

```bash
npm run build:dashboard
HRAUTO_TRACKER_DIR=generated/.dashboard-preview/tracker npm run dashboard:prod -- --port 3941
# http://localhost:3941/?view=rebuild-demo
# After every rebuild: restart the server AND `playwright-cli close`
# Port 3838 is the operator's own dashboard — never touch it
```

Drive and screenshot both themes against:

| Item | Screenshot |
|---|---|
| 1 selected highlight | `06-item1-row-highlight-too-light.png` |
| 2 member well | `05-item2-member-list-black-bg.png`, `30-item2-i9-50-members.png` |
| 3 chips | `07-item3-backlink-chip.png` |
| 5 lightbox / recorded | `09-item5-capture-lightbox-empty.png` |
| 6 toast independence | `10-item6-toasts-coupled-to-log-panel.png` |
| 7 add workers | `11-item7-add-workers-modal.png` |
| 8 evidence | `12-item8-evidence-section.png` |
| 9 rail counts | `13-item9-rail-eye-badges.png` |
| 10 review space | `14-item10-review-pane-dead-space.png` |
| 12 collapsed panel | `16-item12-panel-collapsed-sliver.png` |
| 13 app version | `17-item13-archive-app-version.png` |
| 15 title/subtitle | `18-item15-title-subtitle-spacing.png` |
| 16/17 Activity | `19`/`20`/`21` |
| 18 toolbar height | `23-item18-toolbar-heights.png` |
| 19/20 redundancy | `24`/`25`/`26`/`27`/`28` |

Also: Settings → Workflow capabilities; Explorer → Onboarding dry-run line at I-9 creation; nav ←→ after a cross-workflow link; write-parked footer ✕ with no duplicate Resolve.

### Hard-won gotchas (carry forward)

- After `build:dashboard` you MUST restart `dashboard:prod` and `playwright-cli close`, or you screenshot a stale bundle.
- Port `N+1` is the phone-capture sidecar — consecutive ports collide across agents.
- A worktree has no `.env`, so `dashboard:prod` dies there immediately.
- Never `checkout` / `stash` / `reset` this shared tree — prior sessions discarded uncommitted operator files that way.
- When you fix a primitive (`Chip`, selected surface, toolbar height), sweep hand-rolled siblings.
- Toast viewport and DecisionNotice must stay in **different coordinate spaces** — neither may read the other's presence.
- One writer per tree; use worktrees for genuine parallelism and merge yourself.

## Suggested commit order (when ready)

1. **Product dry-run** — `src/workflows/onboarding/{workflow.ts,CLAUDE.md,schema.ts}`, `tests/unit/workflows/onboarding/workflow.test.ts`, ledger §0 update.
2. **Demo feedback wave** — explicit paths under `src/dashboard/components/dev/rebuild-demo/**`, `UiGallery.tsx`, new/updated `tests/unit/dashboard/rebuild-demo-*.test.ts`, `docs/rebuild/reviews/operator-feedback-2026-07-28-screenshots.md` if you want it tracked.

Verify staged files with `git diff --cached --stat` before every commit. Leave every OCR/operator path unstaged.

## Pointers

- Read first: `docs/rebuild/reviews/operator-feedback-2026-07-28-screenshots.md`, then `src/dashboard/components/dev/rebuild-demo/DESIGN.md`.
- Code home: `src/dashboard/components/dev/rebuild-demo/` — `demo-wire.ts` contract, `demo-data.ts` fixtures, `demo-capability-wire.ts` matrix, `demo-nav-history.ts` history, `ds/` design system, import only via `demo-ui.tsx`.
- Decisions: `docs/rebuild/03-tracker-dashboard.md` §9 = D6–D24.
- Subsystem CLAUDE.md: `src/dashboard/CLAUDE.md`, `src/dashboard/components/CLAUDE.md`, `src/workflows/onboarding/CLAUDE.md`.
- Working style: lean orchestrator + subagents; `/custom-ui` for design surfaces; `/custom-conserve-context` for heavy reads; prefer Opus for frontend design/code when available. Operator prefers plain-language part-by-part sign-off and screenshot feedback.
- Model note from prior session: Opus 5 hit an API usage limit mid-wave; a large frontend delta still appeared in the working tree afterward (timestamps ~03:38–03:46). Treat that delta as **unverified draft code**, not as a finished verified wave.
