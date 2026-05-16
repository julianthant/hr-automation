# Documentation layout

Use this file to decide **what counts as maintained codebase documentation** versus **session artifacts or frozen snapshots**. For code/doc review and drift checks, weigh only the **canonical** tier against `src/` unless a change deliberately targets another tier.

## Git and `.gitignore`

- **`docs/superpowers/`** — **not** ignored. Whatever you commit stays on normal git paths (`git add` works without `-f`). Untracked files here still appear in `git status`; drop or commit them on purpose.
- **`docs/gemini/`** — ignored (optional ad hoc LLM output — prefer Superpowers paths or `handoffs/` for continuity).
- **`.superpowers/`** — ignored (brainstorm mockups).

## Folder map

| Path | Kind |
|------|------|
| `docs/engineering/` | Canonical — conventions + long-form architecture |
| `docs/historical/` | Frozen dated snapshots (e.g. old backlog lists) — not current truth |
| `docs/superpowers/` | Specs, plans, sketches, **session handoffs** (`handoffs/`) — tool/session output — ephemeral |
| `.superpowers/` | Brainstorm mockups — gitignored — ephemeral |

## Canonical (maintained — include in documentation review)

These should stay accurate relative to the code and are fair game for stale-doc findings:

| Location | Role |
|----------|------|
| `docs/engineering/codebase-conventions.md` | Naming, ownership, review rules for shared code |
| `docs/engineering/architecture-deep-dive.md` | Long-form architecture walkthrough |
| `CLAUDE.md` (repo root) | Commands, kernel primer, high-level map |
| `src/**/CLAUDE.md` | Module/workflow/system source of truth |
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

## Repo-adjacent docs

Some conventions reference module-level `AGENTS.md` where present. Prefer `CLAUDE.md` + this README when paths conflict.
