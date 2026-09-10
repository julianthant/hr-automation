# Handoff — rebuild demo: layout, legibility and declutter pass

**Date:** 2026-07-27
**Paused at:** tiers 1–4 built, merged and verified. **Operator reviewed the running demo and gave four pieces of feedback.** None of it is started — this handoff exists to hand that feedback to a fresh session.

## Task summary

`?view=rebuild-demo` is a **dev-only replica** of the future rebuilt HR-automation dashboard. It is a *planning artifact*: the operator's standing framing is *"we practically need this mock/demo to look polished so we can include this in our rebuild plan because we need serious planning before we build the new rebuild or else it will have the same problems as before."* It is deleted once real components ship; production code must never import from `src/dashboard/components/dev/`.

The previous session ratified 15 delegation/presentation decisions (**D6–D20**, `docs/rebuild/03-tracker-dashboard.md` §9) and built the demo out across all four tiers of `docs/rebuild/reviews/demo-feature-plan-2026-07-25.md`. The operator then looked at the result and raised **four items**, three of which are real design problems. The fourth (item 3) is the big one and is as much a *comprehension* problem as a layout problem — read its section carefully before touching code.

## Plan

No superpowers plan file. This handoff IS the spec. Items 1 and 2 are small and unambiguous; item 3 needs a design pass and should probably be brainstormed with the operator before implementation.

## Current state

- Branch: `master`, local only. **Never push without explicit instruction.**
- Worktrees: none. Feature branches: none. All prior waves merged `--no-ff` and swept.
- Tip: `066cb250`. 69 commits landed in the previous session.
- Uncommitted: **not ours** — `.codex/hooks.json` modified and untracked `.github/hooks/` are pre-existing strays. Leave them.
- All gates green as of the tip: `typecheck:all`, `eslint src/dashboard/components/dev`, `build:dashboard`, `test:architecture` (137/137). Zero console errors on boot. Count invariant verified across workflow × status × day.

## The four items

### 1. Session Panel cards must all match the tallest card's height

**Status:** not started. Small.

The Session Panel renders 5 cards (Separations, I-9 Check, OCR, Oath Signature, CRM Doc Download) whose heights vary with content — a card with a lease-wait note and a browser-tile grid is roughly 3× the height of an idle one, and the row reads as ragged. The operator wants them **uniform, sized to the tallest**.

- Code: `src/dashboard/components/dev/rebuild-demo/DemoShell.tsx` (`DemoSessionPanel` and the card body).
- Note the previous polish pass already made an **odd last browser tile span both columns**; keep that.
- The card width token `--ds-w-session-card: 268px` exists in `ds/tokens.css`.
- Equalising height means the short cards gain empty space — decide deliberately what fills it (e.g. the tile grid stretches, or the footer pins to the bottom). Do not fabricate content to fill it.

### 2. Timeline segments must be EQUAL WIDTH regardless of duration — this REVERSES a prior decision

**Status:** not started. Small, but read the whole item.

The demo currently renders the run's steps as **one proportional timeline**: each segment's width is its real recorded duration, with the gate wait as a hatched segment. That was a deliberate operator-directed change in the session before last, and a later agent hardened it (a truly proportional 34-minute gate is 91% of the track and crushes step labels to `3.¹2 4..`, so the gate wedge is drawn clamped to ≤1.5× the step total while its label prints the true age).

**The operator has now reversed this.** Verbatim: *"all the timeline elements should have equal sizes doesnt matter the time. i like the current one in the dashboard. polish that instead of the new design."*

So:
- Segments are **equal width**. Duration stays visible as a **label**, never as a width.
- The model to follow is the **current production step pipeline**: `src/dashboard/components/log-panel/StepPipeline.tsx` (`StepPipeline`, line ~518). Polish *that* shape rather than keeping the proportional design.
- Code to change: `src/dashboard/components/dev/rebuild-demo/DemoLogPanel.tsx` — `Timeline` at line ~314, mounted at line ~1940. The proportional maths (`slot()`, `stepTotal`, `gateSlot`, the `width` style at ~342) all go.
- **Record the rationale so nobody "fixes" it back:** proportional widths were chosen because they were *honest* — the width WAS the data. Equal widths are chosen because they are *legible*, and the duration is still shown numerically beneath each segment, so no information is lost. This is a legibility-over-literalism call the operator made explicitly. It does not violate the no-fabrication rule, because equal widths do not *claim* anything about duration.
- Check whether the gate/wait segment survives at all in the equal-width model, and how `×2` retry markers and the hatched waiting treatment carry over.
- This is a design detail, not one of D6–D20, so no doc-03 amendment is strictly required — but if you want it durable, add it as a decision rather than leaving it in a handoff.

### 3. The Log Panel is too short — and the operator does not know what each row is DOING

**Status:** not started. **This is the real work.** Do not start coding before agreeing a direction with the operator.

Operator, verbatim and in full, because the framing matters:

> *"as we add more stuff, the log panel gets so small that i can barley see the logs. we need to do something about it. maybe have a 3 panel layout where one queue opens 2 panels with one being the logs and data only or sth. we need the log panel and the queue panel to be tall so i can see more data and the rest of the needed data can be shown in a different way as popup or another panel or sth. also i want you to add an info icon on each queue row explaining what is being done in the queue row and the log panel for that row and the purpose of that. dont make it too long. just a short summary should be fine. every row should serve a purpose. i feel like we have too much clutter right now. maybe its because i dont understand what is being done. i know my workflows are complicated. but see if you can find a way to keep the functionality and declutter them and build it like a professional dashboard."*

Three distinct requirements are tangled together here. Treat them separately.

**3a — The Log Panel's vertical budget is consumed before the logs get any.**
Measured on the operator's screenshot at ~1280×720, stacked top to bottom in the right-hand panel: run header (name · status · elapsed · panel kind · trace) → outcome line → meta chips (`by local-operator` · `priority interactive` · `wf v7` · `app 2026.07.3`) → gate banner (title, explanatory paragraph, three buttons) → timeline (labels, bars, durations, clock, working/waiting summary) → evidence bar (filter chips + capture thumbnails + Export) → tabs → **logs**. By the time you reach the log stream there is roughly 150px of a ~600px panel left, and the operator is reading a scrolled sliver.

The operator's own instinct is a **three-panel layout**: the queue opens *two* panels, one of which is logs/data only. Directions worth evaluating (pick with the operator, don't just implement one):

- **A — three columns.** Queue (left) · Logs + Data (centre, tall) · a context rail (right) holding gate, evidence, receipt, identity, meta. The rail collapses. Closest to what the operator described.
- **B — two columns, collapsible run header.** Keep today's split but move gate/timeline/evidence/meta into a run header that collapses once acted on, or into popovers off the header. Cheapest, least structural.
- **C — log takeover.** Opening a run collapses the queue to a narrow strip so the detail panel gets the full width and height.

Whatever is chosen: the **gate banner must never be hidden behind an interaction** — it is the thing that needs a human, and D18's `Needs you` composite exists precisely to make blocked work loud. Same for a failure's "what is half-done" summary.

**3b — Every queue row needs an info affordance explaining what it is and why.**
An **info icon on each queue row** giving a short summary of: what that row is doing, what its Log Panel will show, and the purpose of the row. Short — a couple of sentences, not a document.

Design constraints:
- It must be **derived**, not hand-authored per fixture. The natural key is the row's `workflow` + `rowType` + `containment` (a delegated OCR review row, an operation coordinator, a typed-list group member, and a standalone helper run each deserve a different sentence). See `demo-catalog.ts` — it already names 8 row variants over the 3 ratified types and 4 Log Panel kinds via `rowVariantOf`/`panelKindOf`. **That naming layer is the right place to hang the explanation.**
- It must not become another always-visible chip — the complaint is clutter. An icon that reveals on demand (popover/tooltip) is the point.

**3c — Declutter, without losing functionality.**
The operator's diagnosis is worth taking literally: *"maybe its because i dont understand what is being done."* Some of the perceived clutter is probably **unexplained** rather than **excessive** — which is why 3b may reduce the felt clutter more than deleting elements would.

Suggested method: inventory every visual element on a queue row and in the Log Panel, and for each one state *what question the operator is asking when they need it*. Anything that can't be tied to a real question is a candidate for removal or demotion. Elements that are load-bearing but rarely needed (`app 2026.07.3`, `wf v7`, the actor chip) are candidates for demotion into the info popover or the context rail rather than deletion. **Do not remove anything a ratified decision requires** — re-read D6–D20 first, especially D12 (gate age on the collapsed row), D17 (inline per-member confirmations) and D18 (the pill row).

### 4. This handoff

Done — you're reading it.

## Open questions / deferred decisions

Carried forward from the previous session, none resolved:

- **Q: Are writes editable in the merged Data tab?** Current behaviour: writes are *visible but not editable* (a run's writes are a record of what happened, not a form; the way to change them is to edit the reads they derive from and start a new run). This was a judgement call, flagged to the operator twice, never contested — but never ratified either. It is the one D19 sub-clause without a real decision behind it.
- **Q: Should one failed member promote a whole group to `Failed`?** Applying the ratified rollup precedence literally, `oath-batch` reads **Failed** while holding 11 verified signatures, because `Failed` outranks `Verified done`. Current thinking: this is the precedence working as written, so changing it is a *decision* change, not a bug fix — needs the operator, not a patch.
- **Q: Fix the live bugs in the CURRENT production dashboard now, or only in the rebuild?** The audit list is in `docs/rebuild/reviews/legacy-keep-ditch-2026-07-25.md` §3 (I-9 doc-kind chip never renders, `addBlankRow` injects an EC-shaped record into i9 runs, the record footer chip discards `tracker.label`, Edit Data can block Save with nothing highlighted, screenshot `refreshKey` is a count not a nonce, `runNumber` returns 0, `copyTrace` toasts success unconditionally, `FailedPageCard.onRetryComplete` never passed, plus fail-loud violations on the OCR approve path). Still undecided.
- **Q: When do OCR review edits stop being browser state?** All OCR review edits and record removals live only in `localStorage` keyed by run. Another browser sees un-edited records, and "Re-OCR whole PDF" wipes them with no undo. This collides with the ratified multi-user seams — review edits must become **commands against the run**, not browser state.

New, raised by this feedback:

- **Q: Does the equal-width timeline need a doc-03 decision entry?** It reverses a prior operator-directed design. Current thinking: yes, if only so the next agent doesn't restore proportionality on no-fabrication grounds.

## Verification before resuming

```bash
git status && git log --oneline -5
npm run typecheck:all
npx eslint src/dashboard/components/dev --ext .ts,.tsx
npm run build:dashboard
npm run test:architecture      # 137 expected
```

Then look at the thing being changed (dev-only — no daemon, no tracker data, no Duo):

```bash
npm run build:dashboard
HRAUTO_TRACKER_DIR=generated/.dashboard-preview/tracker npm run dashboard:prod -- --port 3941
#   http://localhost:3941/?view=rebuild-demo   → Dashboard | Row & panel catalog | Design system
#   http://localhost:3941/?view=ui-gallery     → the specimen catalog
```

**Port 3838 is the operator's own dashboard — never touch it.** Sweep after: `playwright-cli close-all` and kill the 3941 server.

Because this is a visual task, typecheck is not proof — drive it headless with `playwright-cli`, assert on the accessibility tree, and **surface before/after screenshots to the operator**. When stitching several captures into one image, label each band clearly as a separate full-window screenshot: the operator previously read a vertically-stacked verification sheet as a layout change.

## Pointers

- **Read first:** `src/dashboard/components/CLAUDE.md` — its 2026-07-26 lessons document the whole demo architecture and every gotcha hit building it (module-body TDZ ordering, the nested-Radix-confirm dismissal, the `dashboard:prod` boot cache).
- **Design system, binding:** `src/dashboard/components/dev/rebuild-demo/DESIGN.md`, plus the live "Design system" view (third view-switcher entry, `DemoUiKit.tsx`) — skim it before hand-rolling any component.
- **Decisions, inviolable:** `docs/rebuild/03-tracker-dashboard.md` §9 = **D6–D20**.
- **Visual parity is ratified:** `docs/rebuild/reviews/second-look-2026-07-22.md` §6.6. Refinement, not redesign — it must still read as the same product.
- **Feature spec:** `docs/rebuild/reviews/demo-feature-plan-2026-07-25.md`. Design ledgers: `docs/rebuild/reviews/{legacy-keep-ditch,delegation-layouts,shell-build-spec}-2026-07-25.md`.
- **Prior handoff (superseded):** `docs/superpowers/handoffs/2026-07-26-rebuild-demo-tiers-1-4.md`.
- **Code:** `src/dashboard/components/dev/rebuild-demo/` — `demo-wire.ts` is the contract, `demo-data.ts` the fixtures + projection, `demo-catalog.ts` the naming layer (the right home for item 3b), `DemoShell.tsx` the shell (item 1), `DemoLogPanel.tsx` the run detail (items 2 and 3a), `ds/` the design system.
- **Memory:** `rebuild-program-temp-src`, `orchestrator-subagent-design-process`, `prefers-interactive-mocks`, `screenshot-chunks-stitch-into-one`.
- **Working style:** the operator prefers a lean orchestrator with subagents doing the heavy work, plain-language part-by-part sign-off, and `/custom-ui` handed to any agent building frontend. For a design question this open-ended, an interactive clickable mock beats a multiple-choice question (`prefers-interactive-mocks`).
