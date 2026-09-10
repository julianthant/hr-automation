# Handoff — Merge Person Match into Person Lookup as modes; broaden the rebuild demo mocks

**Date:** 2026-07-30
**Paused at:** design settled, **zero code written**. All decisions below are ratified by the operator. Execute from task 1.
**Executor:** Codex.

> **Codex note:** Codex reads `AGENTS.md`; this repo documents in `CLAUDE.md`. There is **no** `AGENTS.md` and you must **not** create one (global rule). Read the `CLAUDE.md` files listed under **Pointers** before touching code — they carry the load-bearing conventions (fail-loud, selector registry, row archetypes).

---

## Task summary

Person Lookup and Person Match are two workflows asking two questions about a person against two different UCPath surfaces. The operator wants them **merged into one `person-lookup` workflow with modes**, the way OCR has form specs:

- **Search mode** — today's Person Lookup: UCPath *Person Org Summary* search by name or EID → department, HR status, active/HDH disposition.
- **Match mode** — today's Person Match: UCPath *HR-Tasks person search* keyed on legal name + SSN and/or DOB → does UCPath already know this person (the rehire-vs-new-hire gate).
- **CRM is an optional check bolted onto either mode**, not a fixed part of the chain.

Motivation is flexibility: one workflow, one panel, one queue surface, and the operator picks which question they are asking and whether CRM is consulted — instead of two workflows where one of them (`person-match`) has been dead code with no caller since 2026-07-16.

Same pass: the rebuild demo's mock backend must follow the merge, `i9-lookup` must get mocks (it has **zero** today), and the thin workflows must get real scenario coverage so the demo exercises more than the happy path.

### Why this is safe to do now

`person-match` has **no delegated caller**. `i9-check` (`src/workflows/i9-check/check.ts`) calls the underlying `searchPerson` primitive **in-process** at its own step named `person-match` — it does *not* `ctx.delegateTo` the workflow. Confirmed by grep across `src/`. So the merge touches registry wiring and tests, not a live delegation path.

⚠️ `src/workflows/person-match/CLAUDE.md` currently contains a section titled **"Person Match vs Person Lookup"** that says *"Do not merge these."* That objection was about losing the two distinct UCPath surfaces. The mode design preserves both surfaces, so the objection is resolved — **rewrite that section, don't obey it.** Leaving it in place would make a future session revert this work.

---

## Ratified decisions (do not re-litigate)

| # | Decision | Rationale |
|---|---|---|
| 1 | `mode: "search" \| "match"`, default `"search"` | Existing callers pass no mode and must keep today's behaviour. |
| 2 | `crmCheck?: boolean`, resolved as `input.crmCheck ?? (mode === "search")` | Default **on** for search — `startDate` / `crmFound` / cross-verification are load-bearing for the OCR `verify` flow and delegated callers; flipping the default would silently blank real data. Default **off** for match — Person Match never touched CRM. |
| 3 | Steps stay `["searching", "cross-verification", "active-status", "crm-dates"]` — **no rename** | Step labels ride tracker rows on disk. Match mode reuses `searching` for the HR-Tasks search and `ctx.skipStep`s `active-status` + `crm-dates`. |
| 4 | CRM stays in the **eager** auth chain — do **not** add `deferAuth: true` | `defineSsoLogin` (`src/infra/auth/login.ts:29`) has **no single-flight guard**, and person-lookup runs `batch: { mode: "shared-context-pool", poolSize: 4 }`. Deferring CRM auth would let 4 tabs race into 4 concurrent Duo prompts. `crmCheck` gates the CRM **steps**, not the browser. Say this plainly in the CLAUDE.md — a later session with a single-flight guard can revisit. |
| 5 | Match mode **is startable** from the dashboard | Operator explicitly asked for it ("we will make it a designated caller"). |
| 6 | **Hard-retire** `person-match` — no read alias | Operator chose this over a legacy alias. Old JSONL rows will render with a raw unresolved `person-match` name; that is accepted. |

### Match mode's typed input format

Operator-specified: `name, dob, ssn`, people separated by `;`, and `x` for a field you don't have.

```
Battistessa, Johnnie, 12/04/1998, 123456721 ; Reyes, Marta, 03/19/2001, x
└──────── name ─────┘  └── dob ──┘  └─ ssn ─┘                          └ absent
```

**Parse rule (settled, because a name contains a comma):** split the person on `,`; **the last two fields are DOB then SSN; everything before them joins back into the name.** Deterministic and needs no quoting.

Fail loud (refuse at entry, never guess):
- fewer than 3 comma fields in a person → error naming the offending line
- both DOB and SSN are `x` → error, because UCPath person search offers only NID-based or DOB-based search orders and cannot run on a name alone (this is already the `refine` in `PersonMatchInputSchema`)
- `x` is case-insensitive; a literal `x` is never a value

---

## Current state

- Branch: `master` (219 commits ahead of `origin/master` — **never push**, per global rules)
- Worktrees: none beyond the main checkout
- Uncommitted: **65 files** — a large in-flight rebuild-demo working set (`src/dashboard/components/dev/rebuild-demo/*`, OCR review panes, their tests). **This is pre-existing operator work, not from this session. Do not stash, reset, or clean it.** Commit your own changes by category alongside it (see the grouped-commit rule in the global CLAUDE.md).
- Untracked worth knowing about: `.github/hooks/`, `docs/rebuild/reviews/testing-system-plan-2026-07-27.md`, `scripts/enqueue-onbase-all-from-session.ts`

---

## Progress

- [ ] **1 — Merge the workflow (real backend)** ← **resume here**
- [ ] 2 — Hard-retire the `person-match` name
- [ ] 3 — Wire the Match start surface
- [ ] 4 — Update the rebuild docs
- [ ] 5 — Update the demo wire (rebuild's mock backend)
- [ ] 6 — Merge the Explorer graphs
- [ ] 7 — Mock `i9-lookup` + broaden scenario coverage
- [ ] 8 — Verify

Commit by category as you go (one commit per task, roughly) — not one mega-commit at the end.

---

## Task 1 — Merge the workflow (real backend)

**`src/workflows/person-lookup/schema.ts`**
- Add `mode: z.enum(["search","match"]).default("search")` and `crmCheck: z.boolean().optional()` to the shared fragment.
- Add `PersonLookupMatchInputSchema` — port `PersonMatchInputSchema` from `src/workflows/person-match/schema.ts` verbatim (`lastName`, `firstName`, `ssn?`, `dob?`, `PARENT_SUBJECT_FRAGMENT`, plus the `refine` requiring SSN or DOB). Note it uses `zod/v4` while person-lookup's schema uses `zod` — unify on whichever the person-lookup file already imports and re-check the `.refine` still compiles.
- `PersonLookupItemSchema` becomes a 3-way union: name | eid | match.
- Add type guard `isMatchInput(input)`.
- Add `parsePersonLookupMatchLine(line)` exported pure helper implementing the parse rule above (unit-testable without a browser).
- Extend `derivePersonLookupItemId` and `displayPersonLookupInput` for the match shape (`"Last, First"` + a DOB/SSN-presence hint).

**`src/workflows/person-lookup/match.ts`** (new)
- Move `handlePersonMatch`'s body from `src/workflows/person-match/workflow.ts` (it is ~30 lines). It calls `searchPerson(page, ssn ?? "", firstName, lastName, dob ?? "")` from `src/systems/ucpath/navigate.ts` (returns `{ found, matches?: [{emplId, firstName, lastName}] }`) and stamps `found` / `matchedEmplId` / `matchedName`, then screenshots.
- Keep the `searchImpl` injection parameter — the existing test suite depends on it.

**`src/workflows/person-lookup/workflow.ts`**
- `handler` branches on mode at the top.
  - match → `ctx.step("searching", …)` runs the match search; then `cross-verification` only if `crmCheck` resolves true, else `ctx.skipStep("cross-verification")`; then `ctx.skipStep("active-status")` and `ctx.skipStep("crm-dates")`.
  - search → today's chain, but `cross-verification` now sits behind the same `resolveCrmCheck` gate. **When gated off, do not stamp `crmFound: "Not found"`** — that would claim CRM was consulted and missed. Stamp nothing, or a distinguishable "not checked". Getting this wrong is exactly the fail-loud trap the root CLAUDE.md warns about.
  - Audit `activeStatusStep` — it reads `ctx.data.crmMatch` / `ctx.data.crmFound` and has a `crm-only` branch. With CRM skipped those are absent; confirm it lands on the plain `deriveActiveCheckOutcome` path and does not read "CRM missed".
- `inputSubject` resolver: match inputs → `"name"`.
- `operatorSubject` / `initialData`: handle the match shape.
- `detailFields`: add `found` / `matchedEmplId` / `matchedName` as `conditional: true` so search rows don't grow empty columns.
- Export a `PERSON_LOOKUP_MODES` const if the dashboard needs the list.

**`src/domain/person-lookup-status.ts`**
- Fold in person-match's rule: `entry.status === "done" && entry.data?.found === "false"` → `"notFound"`, alongside the existing `isTerminalNotFoundEntry` rule. Keep both; match rows have no `activeStatus`, so the secondaryTag branch already no-ops for them.

**Tests** — move `tests/unit/workflows/person-match/{schema,workflow}.test.ts` under `tests/unit/workflows/person-lookup/` and retarget at the merged workflow. Add cases for: the typed-line parser (incl. a name with a comma, `x` in each slot, both-`x` refusal, <3 fields), mode defaulting to `search`, `crmCheck` defaulting per mode, and match mode skipping `active-status`/`crm-dates`.

## Task 2 — Hard-retire `person-match`

Delete:
- `src/workflows/person-match/` (whole dir: `workflow.ts`, `schema.ts`, `index.ts`, `config.ts`, `CLAUDE.md`)
- `src/domain/person-match-status.ts`

Remove the entry from:
- `src/core/workflow-loaders.ts:76-78`
- `src/tracker/dashboard/workflows.ts:22` (eager import)
- `src/tracker/session-events.ts:411` (`INSTANCE_LABELS`)
- `src/domain/queue-row-status-index.ts:20,28` (import + `registerWorkflowStatusExtensions`)

Then sweep — these files also name it and need review, mostly in prose/comments:
`src/services/ocr/forms/i9.ts` (deprecated `personMatchStatus` / `personMatchTraceId` fields at :194-197 — keep, they are historical-row compat; the `buildI9PersonMatchInput` / `applyPersonMatchToI9Record` helpers at :570-660 are still used, **do not delete, consider renaming only if cheap**), `src/workflows/i9-check/{check,schema,workflow,select-by-hire-date}.ts` (its *step* is named `person-match` — that is an i9-check step label, **leave it alone**), `src/workflows/ocr/force-research.ts`, `src/domain/workflow-runtime/projection.ts:176`, `src/systems/ucpath/{LESSONS.md,selectors.ts}`, `src/dashboard/components/ocr/{OcrReviewPane,RecordScreenshotStrip,types}.ts*`, `src/services/ocr/CLAUDE.md`, `src/workflows/CLAUDE.md`, `src/workflows/i9-check/CLAUDE.md`, `src/dashboard/components/CLAUDE.md`, `scripts/seed-i9-fixture.ts`.

Architecture guards that reference it and will need updating: `tests/unit/architecture/runtime-policy-coverage.test.ts`, `tests/unit/architecture/nullish-literal-data-fallback.test.ts`.

## Task 3 — Wire the Match start surface

`src/dashboard/lib/input-run-registry.ts`:
- `parsePersonLookupInputs` (:133) currently splits on `;` and discriminates numeric → `{emplId}` else `{name}`. It needs to become mode-aware. `InputRunConfig` has no "choices" concept today — only `supportsDryRun` (:61), rendered by `RunSettingsMenu.tsx` and `InputRunPanel.tsx:173`.
- **Recommended shape:** add a generic optional `modes?: { key, label, placeholder, parseInput, note }[]` to `InputRunConfig`, render it as a segmented control above the text box in `InputRunPanel.tsx`, and add a `crmCheck` toggle to `RunSettingsMenu` mirroring how `supportsDryRun` is threaded. Fold the chosen mode + `crmCheck` onto every parsed input on submit (same mechanism `dryRun` uses at `InputRunPanel.tsx:74`).
- Keep the mode picker generic — do **not** special-case `person-lookup` in the panel component; the registry entry should be the only place that knows.

## Task 4 — Update the rebuild docs

- `docs/rebuild/03-tracker-dashboard.md:1379` — **D15 "`person-match` keeps its Workflow Panel entry"**. This decision is now superseded. Rewrite it as "Person Lookup carries Search and Match as modes" and record why (one workflow, one panel; the mode is a start choice like OCR's form spec).
- `docs/rebuild/05-execution-parallelism.md:470,485,487` — the phase-2 worked example runs `person-match` → `person-lookup` per member. Restate as one `person-lookup` run in match mode, then search mode (or one run doing both) and re-check the timing diagram still adds up.
- `docs/rebuild/07-master-plan.md:507` — migration wave 1 lists **person-match, i9-lookup** as the first workflows to port. Drop person-match; the wave becomes person-lookup (both modes) + i9-lookup.
- `docs/rebuild/reviews/backend-capabilities-from-the-demo-2026-07-28.md:103` — mentions person-lookup's outcome vocabulary; extend it with the match answers if you add any.

## Task 5 — Update the demo wire (the rebuild's mock backend)

`src/dashboard/components/dev/rebuild-demo/demo-wire.ts`:
- Remove `"person-match"` from `DemoWorkflowId` (:202) and from `DEMO_WORKFLOWS` (:1025).
- `person-lookup` entry (:976) gains:
  - a `mode` **choice** modelled exactly on `OCR_FORM_TYPE_OPTIONS` (:522) — that is the in-repo precedent for "one workflow, several modes", and the operator explicitly asked for the OCR shape;
  - a second `typed` start **method** for Match with `separator: "semicolon"`, the `Name, DOB, SSN` `parserLabel`, and `examples` covering: two people, one with `x` for SSN, and a refused line (both fields `x`);
  - a `crmCheck` **flag** (the `flags` array already carries `dryRunFlag()` — follow that helper's shape);
  - member outcomes for the match answers (`matched` / `no-match` / `ambiguous`), added alongside `PERSON_LOOKUP_MEMBER_OUTCOMES` (:~950). Follow the vocabulary rules written in that block's doc comment: declare answers the workflow *can* give even if no fixture currently returns them, and keep the ordinary answer the quietest.
- Delete person-match's `notStartable` + `absences`; move anything still true onto person-lookup's `absences`.

Then sweep the demo's other wire files: `demo-report-wire.ts:74-76` (drop the `person-match` weight), `demo-catalog.ts:89-90` (the `pm` catalog entry), `DemoShell.tsx:652` (`"Person Match"` label branch), `demo-evidence-wire.ts:1010` (`nodeId: "person-match"`), `demo-archive-wire.ts`.

## Task 6 — Merge the Explorer graphs

`src/dashboard/components/dev/rebuild-demo/demo-explorer-wire.ts`:
- Fold `PERSON_MATCH_GRAPH` (:~657) into `PERSON_LOOKUP_GRAPH` (:543) as a **lane** — the file already has the lane vocabulary (`PER_PERSON`, `DELEGATED_BATCH`, …); add a `MATCH` lane constant. Its single `Search` node keeps its contract rows (`Found`, `Matched EID`, `Matched name`, `Candidates`) and `uiIds`.
- Add the `when` conditions so the CRM node reads as optional on both lanes.
- Remove `PERSON_MATCH_GRAPH` from `EXPLORER_GRAPHS` (:1689-1705) and delete the const.
- Rule 3 in this file's header says **every workflow in the registry serves a graph** — after removing person-match from the registry, re-run `tests/unit/dashboard/rebuild-demo-explorer.test.ts`, which enforces exactly that.
- `I9_LOOKUP_GRAPH` (:~688) already exists and is fine; it just has no run to overlay — task 7 fixes that.

## Task 7 — Mock `i9-lookup` + broaden scenario coverage

Current mock-row counts in `demo-data.ts` (`grep -c 'workflowId: "…"'`):

| workflow | rows | |
|---|---|---|
| person-lookup | 7 | |
| separations | 6 | |
| emergency-contact | 6 | |
| ocr | 5 | |
| oath-signature | 4 | |
| work-study | 3 | |
| sharepoint-download / onbase / i9-check | 2 each | |
| onboarding / oath-upload / kronos-pay-rule / crm-doc-download / old-kronos-reports | **1 each** | thin |
| **i9-lookup** | **0** | ← operator called this out |
| person-match | 0 | (being retired) |

Do:
- Add `i9-lookup` rows — it is delegated-only, so they should appear as delegated children under a parent run (`parentRunId`), which is also what gives the Explorer a run to overlay on `I9_LOOKUP_GRAPH`. Cover: profile found + signed, profile found + unsigned, no profile (a real negative answer, **not** a failure), and portal unreachable (a genuine failure — the graph's `purpose` text already distinguishes these two and the mocks should prove it).
- Add Match-mode `person-lookup` rows: matched, no match, and the ambiguous/duplicate-dialog case.
- Bring each thin workflow up to ≥3 rows with **distinct outcomes**, not repeats. Aim at the states the UI has to render and currently never sees: a park/resolve checkpoint, a failed run with a retry, a dry run, a cancelled run, a partially-failed member fan-out, a not-found terminal, a version-bumped row.
- Keep the demo's single-sourcing discipline — `tests/unit/dashboard/rebuild-demo-*.test.ts` pin several invariants (attention counts, evidence, record stream, row density, worker spawn). Run them as you add rows; they are the guard against fixtures drifting from the wire schema.

## Task 8 — Verify

```bash
npm run typecheck:all
npm run test
npm run test:architecture
npm run lint
npm run build:dashboard
```

Then see the demo actually render (mandatory per root CLAUDE.md — do not ship a dashboard change on typecheck alone):

```bash
npm run build:dashboard
HRAUTO_TRACKER_DIR=generated/.dashboard-preview/tracker npm run dashboard:prod -- --port 3939 &
playwright-cli -s=preview open http://localhost:3939
playwright-cli -s=preview snapshot                    # a11y tree is the authoritative assertion
playwright-cli -s=preview screenshot --filename "$(pwd)/.screenshots/person-lookup-modes/x.png"
playwright-cli close-all && pkill -f 'dashboard --prod --port 3939'
```

Surface the screenshots back to the operator — Person Lookup's mode picker, a Match-mode run, the merged Explorer graph, and the new `i9-lookup` rows. Root CLAUDE.md requires the operator to *see* the rendered result, and there is a memory entry saying to stitch a multi-image set into **one** vertically-stacked ordered image rather than N separate PNGs.

`:3838` is usually the operator's own dashboard — use the fallback port and never kill it.

---

## Open questions / deferred decisions

- **Q: should Match mode chain into Search once it has an EID?** — Deferred. It would be a genuine improvement (match answers "who", search answers "what is their status"), but the operator said "match is the match's workflow", i.e. port it as-is. Do not add it in this pass; note it as a candidate.
- **Q: lazy CRM auth so an unused CRM never Duos?** — Deferred by decision 4. The blocker is the missing single-flight guard in `defineSsoLogin`, not the workflow. A future pass could add one and then set `deferAuth: true` on CRM.
- **Q: `i9-check`'s step is literally named `person-match`.** — Left alone deliberately; it names an in-process step, not the retired workflow. Renaming it would invalidate step labels on tracker rows already on disk.
- **Q: old `person-match` JSONL rows.** — Operator chose hard retirement, accepting that those rows render with an unresolved workflow name. If that turns out to be uglier than expected in the queue, the fallback is a read-side alias in `session-events.ts` + `queue-row-status-index.ts` (this was the rejected option, so re-raise it rather than silently adding it).

---

## Pointers

**Read these `CLAUDE.md` files first** (Codex will not pick them up automatically):
- `CLAUDE.md` (root) — fail-loud rule, row archetypes, live-verification pre-authorization, dashboard verification loop
- `~/.claude/CLAUDE.md` — commit/branch strategy, no `AGENTS.md`, Playwright-CLI-only browser rule
- `src/workflows/CLAUDE.md`, `src/workflows/person-lookup/CLAUDE.md`, `src/workflows/person-match/CLAUDE.md` (read before deleting — the "Person Match vs Person Lookup" section and the 2026-07-13 dead-selector lesson should be **migrated into person-lookup's CLAUDE.md**, not lost)
- `src/workflows/i9-check/CLAUDE.md`, `src/core/CLAUDE.md`, `src/dashboard/CLAUDE.md`, `src/dashboard/components/CLAUDE.md`
- `src/systems/ucpath/LESSONS.md` — the 2026-07-13 `personSearch.resultEmplIdCells` lesson is the reason match mode works at all

**Rebuild program context:** `docs/rebuild/00-charter.md` → `12-…`, and `docs/rebuild/reviews/` (esp. `backend-capabilities-from-the-demo-2026-07-28.md`, `demo-feature-plan-2026-07-25.md`).

**Memory entries** under `~/.claude/projects/-Users-julianhein-Projects-hr-automation/memory/`:
- `rebuild-program-temp-src.md` — rebuild program state
- `fail-loud-no-unverified-fallbacks.md` — the rule most likely to be violated by the `crmCheck` gate
- `orchestrator-subagent-design-process.md` — the operator's preferred working style
- `screenshot-chunks-stitch-into-one.md` — how to surface the task-8 verification images
- `i9-check-restructure-2026-07-16.md` — why i9-check stopped delegating to person-match

**Do not** run `eslint --fix`, formatters, or codemods across the tree — there are 65 uncommitted files of the operator's in-flight work. See the `custom-hr-tree-guard` skill.
