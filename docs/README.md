# Documentation layout

Use this file to decide **what counts as maintained codebase documentation** versus **session artifacts or frozen snapshots**. For code/doc review and drift checks, weigh only the **canonical** tier against `src/` unless a change deliberately targets another tier.

## CLAUDE.md vs docs/engineering/ — what goes where

**`CLAUDE.md` files** (root + every `src/**` module) are part of the Claude Code system prompt and are loaded for every session in that directory. Keep them concise:

- ✅ **Commands** to run, quick reference
- ✅ **Critical gotchas** — things that will bite you if you don't know them
- ✅ **Design invariants** — rules that must not be broken
- ✅ **Lessons Learned** — mistakes made; one line per lesson
- ✅ **Brief orientation** — what the module owns, 3–5 sentences
- ✅ **Pointers** to docs/engineering/ for full reference
- ❌ Full endpoint tables, complete API docs, file-by-file descriptions → docs/engineering/
- ❌ Component trees beyond top-level structure → docs/engineering/
- ❌ Exhaustive data-type definitions → docs/engineering/
- ❌ Long how-it-works narrative → docs/engineering/ or architecture-deep-dive.md

**Target size**: root CLAUDE.md ≤ 15k chars; module CLAUDE.md files ≤ 8k chars.  
**Why**: at ~40k combined chars the Claude Code prompt performance warning fires. When working in `src/dashboard/`, three CLAUDE.md files load (global 14k + root 19k + module): the module budget is ~7k before the threshold.

**`docs/engineering/`** is the right home for full reference material that you consult when building or debugging — not on every session start. **`docs/workflow/`** is the canonical workflow behavior and delegation map.

## Git and `.gitignore`

- **`docs/superpowers/`** — **not** ignored. Whatever you commit stays on normal git paths (`git add` works without `-f`). Untracked files here still appear in `git status`; drop or commit them on purpose.
- **`docs/gemini/`** — ignored (optional ad hoc LLM output — prefer Superpowers paths or `handoffs/` for continuity).
- **`.superpowers/`** — ignored (brainstorm mockups).

## Folder map

| Path | Kind |
|------|------|
| `docs/engineering/` | Canonical — conventions + long-form architecture + module reference |
| `docs/workflow/` | Canonical — workflow behavior, row shapes, delegation, and cancel/retry scopes |
| `docs/historical/` | Frozen dated snapshots (e.g. old backlog lists) — not current truth |
| `docs/superpowers/` | Specs, plans, sketches, **session handoffs** (`handoffs/`) — tool/session output — ephemeral |
| `.superpowers/` | Brainstorm mockups — gitignored — ephemeral |

## Canonical (maintained — include in documentation review)

These should stay accurate relative to the code and are fair game for stale-doc findings:

| Location | Role |
|----------|------|
| `docs/engineering/codebase-conventions.md` | Naming, ownership, review rules for shared code |
| `docs/engineering/architecture-deep-dive.md` | Long-form architecture walkthrough |
| `docs/engineering/dashboard-api-reference.md` | Full Dashboard API: endpoints, types, hooks, icons, file tree |
| `docs/engineering/tracker-reference.md` | Tracker module internals: file-by-file, JSONL format, cleanup, withTrackedWorkflow |
| `docs/engineering/core-internals.md` | Kernel internals: kernel/, daemon/, task-store/ file-by-file |
| `docs/engineering/daemon-teardown-state-machine.md` | Map of the daemon claim/force-stop/reassign/stop-all transitions (states × intents × where each lives), the recurring-bug gap analysis, and the proposed explicit-transition-table refactor (planned, not yet executed) |
| `docs/engineering/workflow-patterns.md` | Daemon-mode conversion template, edit-data opt-in recipe |
| `docs/engineering/hands-off-duo-webauthn.md` | Hands-off Duo via CDP WebAuthn: enrollment, two-phase factor selection, the six Duo flows, testing, and failure modes |
| `docs/workflow/README.md` | Workflow delegation index: row units, global actions, cancellation rules, workflow inventory |
| `docs/workflow/*.md` | Per-workflow behavior, delegation, row shape, and cancel/retry scope notes |
| `CLAUDE.md` (repo root) | Commands, kernel primer, high-level map (≤15k) |
| `src/**/CLAUDE.md` | Module/workflow/system gotchas, invariants, lessons (≤8k each) |
| `LESSONS.md` (repo root) | Cross-cutting operational lessons |
| `src/systems/<system>/LESSONS.md` | Per-system selector/UX lessons |
| `src/systems/<system>/SELECTORS.md` | Auto-generated selector catalog (regenerated from `selectors.ts`) |

## Session handoffs (exclude from default documentation review)

| Location | Role |
|----------|------|
| `docs/superpowers/handoffs/` | `/handoff` briefs, paste-ready resume notes, review-fix summaries, other continuity markdown |

## Frozen historical snapshots (exclude from default documentation review)

| Location | Role |
|----------|------|
| `docs/historical/` | Dated backlog/snapshot files preserved as-is (see `docs/historical/README.md`) |

## Other Superpowers tool output (exclude from default documentation review)

| Location | Role |
|----------|------|
| `docs/superpowers/plans/`, `specs/`, `sessions/`, `sketches/`, … | Plans and design artifacts (committed paths are tracked; extra local-only files still appear in `git status` until you commit or delete them) |
| `.superpowers/` | Superpowers brainstorm mockups (**gitignored**) |

Cross-links from `CLAUDE.md` or module docs into `docs/superpowers/specs/…` are **historical pointers**; the spec may describe why something was built, not necessarily the live behavior.
