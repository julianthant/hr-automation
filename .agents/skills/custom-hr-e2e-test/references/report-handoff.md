# Phases 8–9 — Review, fixes, HTML report, approval gate, handoff

## Phase 8 — Review + fixes

### 8.1 Fix confirmed ledger issues

Fix defects that are safely fixable now — small, evidence-backed. Each fix
follows the **promotion gate** (pin first, then fix):

- **a. Pin it red.** Before touching product code, write the deterministic
  regression test in the LOWEST layer that can hold the finding — a
  `tests/delegation/` daemon-soak case for teardown/concurrency/projection,
  a `tests/unit/core/daemon*.test.ts` case for a daemon-state contract, a
  plain unit test for pure logic. **Author this pin with the
  `/test-writer:test-writer` skill** (one invocation per fix, after the fix
  diff exists so it can discover the changed code) — it maps the code paths,
  writes the test in the project's conventions, and runs the break-it check.
  Run it; confirm it FAILS reproducing the finding's symptom (not a different
  failure). If you cannot reproduce it deterministically at any layer below
  the headed browser, that is itself a signal — say so in the ledger
  (`rootCause.confidence:"low"`) and treat the fix as higher-risk.
  **This is mandatory: every confirmed-finding fix gets a `/test-writer`
  regression pin — no fix is "done" without one** (the completion gate and
  the ledger's `regressionTest` field both enforce it).

  *Repo gotcha for handler/workflow pins:* this repo's vitest runs
  single-fork with a SHARED module cache, so a static top-level `import` of a
  workflow binds the REAL collaborators before `vi.mock` applies. Use
  `vi.hoisted` spies + `vi.resetModules()` + a DYNAMIC `await import()` of the
  workflow (pattern in `tests/unit/workflows/ocr/workflow.test.ts` and
  `tests/unit/workflows/separations/dry-run.test.ts`), and drive a handler's
  guard logic with a hand-rolled ctx rather than the full kernel (the
  parallel-staggered auth stagger makes full-kernel runs slow and brittle).

- **b. Fix the root**, not the symptom — the minimal change that turns the
  pin green. If the same `rootCause.where` underlies multiple findings, fix
  once there and let all their pins go green (the daemon-teardown nest is the
  standing example — N symptoms, one transition bug).

- **c. Record it.** Set the finding's `regressionTest` to the new test's path
  and `status:"fixed"`. A finding fixed with `regressionTest:null` does NOT
  count as fixed — it will be rediscovered by the next expensive run.

- **d. Prove it in the UI.** Capture the BEFORE screenshot from the run
  artifacts, restart what's needed (backend changes need a full dashboard
  restart), reproduce the original scenario, capture the AFTER screenshot.

- Commit per logical category as you go. Anything too large/risky to fix now
  (a real daemon-core refactor) stays `confirmed` + deferred in the ledger
  and goes to the handoff with its root cause, NOT silently dropped — say so
  explicitly in the report.

### 8.2 Code + performance + simplify review — invoke `/custom-review-code`

**INVOKE the `/custom-review-code` skill** over the changes made in 8.1. `/custom-review-code`
is the single source of truth for how we review — parallel code-reviewer /
performance-reviewer / code-simplifier as it sizes them; whether to run
ui-ux-pro-max on frontend-visible changes is its call (per standing preference:
only for substantial visual changes, not trivial nits). Apply accepted feedback.

The two e2e-specific rules that layer ON TOP of the `/custom-review-code` output:

1. **Promotion gate check.** For every finding `/custom-review-code` surfaces in the
   existing diff: if it is a confirmed e2e ledger issue, verify its
   `regressionTest` is non-null before considering it done. An unpinned fix
   returned by `/custom-review-code` must get a `/test-writer` pin before closing.

2. **Targeted e2e re-run.** After applying accepted feedback and before the
   report, re-run the affected slice of the e2e (targeted, not the whole
   matrix) to confirm each fix's AFTER state, plus `npm run test`, `npm run
   test:architecture`, and `npm run lint`. Every newly-added regression pin
   from step 8.1a now runs inside `npm run test` (green) — that, not the
   targeted re-run, is the durable proof the bug stays dead. Confirm no
   `confirmed` finding still has `regressionTest:null` unless it is an
   explicit deferral.

**Docs after code settles.** Updating the nearest CLAUDE.md for any
non-obvious contract a regression test discovered is normal Claude practice for
any file it touched — do it as part of normal work. Deep documentation review
is the user's call to trigger manually. **Do NOT invoke a doc-reviewer agent
as part of this skill.**

## Phase 9a — HTML report (`generated/.e2e/runs/<ts>/report.html`)

Produce the report using the **canonical reporter** shared with `/custom-review-code`:

```bash
node ~/.claude/skills/custom-review-code/scripts/render-report.mjs \
  generated/.e2e/runs/<ts>/findings.json \
  generated/.e2e/runs/<ts>/report.html
```

The findings JSON schema is at
`~/.claude/skills/custom-review-code/references/report-schema.md`. Build the object
by mapping the e2e run artifacts:

**`meta`**: title `"E2E Run <ts> — results"`, subtitle with the phase count and
workflow matrix size, `generatedAtLabel`.

**`scorecard[]`**: phases run vs planned, checkpoints passed/failed, issues by
severity (`tone:"bad"` for any high), fixed-now vs deferred, and a **promotion
card** ("Pinned" = N fixed issues with `regressionTest` non-null; tone `ok` when
all fixed findings are pinned, `bad` when any are not). An empty promotion count
on a non-zero `fixed` count is a red flag the report must surface, not hide.

**`findings[]`** (one entry per confirmed ledger issue, ordered severity-first):
- `id` ← the `ISS-NNN` id, `severity`, `status` (`fixed|deferred|rejected`),
  `kind` (`visual|code|backend|perf`), `area`, `file`, `line`.
- Visual findings: `current.screenshot` ← the BEFORE artifact path,
  `fixed.screenshot` ← the AFTER artifact path, `fixed.note` ← the regression
  test path (e.g. `tests/unit/core/daemon.test.ts::"VQ-003"`). The reporter
  renders BEFORE/AFTER side by side and the note as the "Proposed fix" rationale.
- Backend-only findings: `fixed.note` ← plain-language explanation of what the
  fix changed + the regression test path.
- `flow[]` ← step diagram of where the data/state went wrong (the
  enqueue → claim → re-emit → render chain with the failing hop marked `"bad"`).
- `evidence[]` ← artifact paths from the ledger entry.

**`themes[]`**: cross-cutting themes from the `/custom-review-code` pass + a
"Parallel-workers verdict" theme (spawn/reuse/reassign/stop-all results with the
session-event evidence condensed into `detail`).

**`appendix`**:
- `manifest` ← the phase manifest rows (one object per checkpoint: `phase`,
  `action`, `ok`, `workaroundUsed` if any).
- `ledger` ← all ledger entries (each as a flat object with `id`, `severity`,
  `status`, `area`, `title`, `regressionTest`).

No extension to `render-report.mjs` is needed: the regression test path maps
into `fixed.note` (rendered as "Proposed fix" rationale), the parallel-workers
verdict maps into `themes[]`, and the manifest + full ledger map into `appendix`.
The schema can carry all e2e-specific content as-is.

Open it in the browser for the user. **STOP HERE for approval** — the user
reviews the report and approves/amends the fixes before any handoff is
written. This is the one deliberate gate in the skill.

## Phase 9b — Handoff doc (`generated/.e2e/runs/<ts>/custom-handoff.md` + `docs/superpowers/handoffs/`)

After approval, write the next-session handoff. It is deliberately richer
than a generic `/custom-handoff`: the next session must be able to execute WITHOUT
re-deriving anything. Required sections:

```
# E2E follow-up handoff — run <ts>
## State of the world
   What was tested, what passed, commits landed this session (hashes +
   one-liners), where the artifacts live, how to re-create the env
   (exact exports + commands).
## Errors that remain (one block per deferred issue)
   - ISS-id + title + severity
   - Exactly what happens (symptom, repro steps against the e2e env,
     evidence paths)
   - Root cause as currently understood (file:line) + confidence level
   - The fix needed, concretely (files to touch, approach, gotchas from
     CLAUDE.md/lessons that apply)
   - How to verify the fix (the targeted e2e slice to re-run + assertions)
## Execution plan for the next session
   Ordered, SEQUENTIAL task list — each task names the subagent type to
   dispatch (code fix → general-purpose or feature-dev:code-architect for
   design-heavy ones; verification → Explore; review → code-reviewer),
   its inputs, and its done-criteria. State explicitly that tasks run
   sequentially (each depends on the prior fix landing) unless a pair is
   provably independent — then and only then note the worktree-discipline
   rules apply.
## Paste-ready prompt
   A short prompt the user can paste into a fresh session that points at
   this file and says "execute sequentially with the named subagents."
```

Delete the handoff after the follow-up session completes it (stale handoffs
mislead future sessions — standing rule).
