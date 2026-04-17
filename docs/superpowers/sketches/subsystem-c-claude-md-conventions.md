# Subsystem C — CLAUDE.md Conventions (Design Sketch)

**Status:** Sketch only. Not yet brainstormed or specced. Scheduled to run LAST of the four subsystems.
**Priority:** #4 of 4 remaining subsystems.
**Estimated effort:** ~0.5-1 working day.

## Problem

The user's stated pain (#5 in the original ranking): "Future Claude sessions drift off-pattern." Documentation in `CLAUDE.md` files describes the old way of doing things:

- Root `CLAUDE.md` has a "Multi-Browser Parallel Execution" section (~200 lines) describing auth-ready promise chains and phase parallelism by hand. **This is now implicit in the kernel.** Keeping it describes how NOT to write workflows.
- Root `CLAUDE.md` `## Architecture` still lists `src/systems/` only partially (ucpath only, after Phase 2 migration 1). Will need updating as migrations land anyway.
- Per-module `CLAUDE.md` files reference patterns that changed: `withTrackedWorkflow`, `withLogContext`, `launchBrowser`, `setStep`. None of these are called directly anymore.
- **No "writing a new workflow" checklist** that points at `defineWorkflow`'s type signature.
- `## Verified Selectors` sections are scattered and format-inconsistent — this overlaps with subsystem A's deliverable.
- `## Lessons Learned` sections have been accruing. Some are obsolete (refer to deleted code), some are critical (refer to PeopleSoft gotchas that still bite).

After B+E, A, and D land, the CLAUDE.md files are a mix of stale + fresh guidance — a maintenance mess that misleads future Claude sessions instead of helping them.

## Goal

Every CLAUDE.md file accurately reflects the current architecture. Future Claude sessions reading them produce code that uses the kernel correctly on the first try, without the session needing to reverse-engineer the pattern from other workflows.

## Rough approach

### Audit + classify every CLAUDE.md

Scan every `CLAUDE.md` in the repo. For each section:
- **Keep** — still accurate, still useful
- **Update** — was useful, needs rewording for new architecture
- **Delete** — described old pattern, now misleading
- **Move** — belongs in a different CLAUDE.md file (e.g. selector guidance should be per-system)

Produce an audit report as a dry run before any edits.

### Root CLAUDE.md rewrite

Target structure:

1. **What this project is** (unchanged)
2. **Commands** (unchanged; just the npm scripts table)
3. **Architecture** — short prose + directory tree diagram. Link to the kernel spec for details.
4. **Writing a new workflow** — new section. Points at `defineWorkflow` type signature, shows a minimal example, lists the 1-line `cli.ts` addition.
5. **Environment** (unchanged)
6. **Gotchas** — triaged: keep PeopleSoft/UKG/Kuali gotchas that still apply; delete gotchas about patterns the kernel solves.
7. **Delete** the "Multi-Browser Parallel Execution" section entirely — it described hand-coding what the kernel now does.
8. **Delete** the "ActionPlan pattern" mention if ActionPlan is kernel-integrated (TBD — this depends on whether ActionPlan survives the migration).

### Per-module CLAUDE.md files

Template per `src/systems/<system>/CLAUDE.md`:

- **What this system is** — 2-3 sentences
- **Files** — list the key modules, one-line descriptions
- **Verified Selectors** — structured list, one entry per selector family, with verified date (this section is owned by subsystem A but rendered here)
- **Gotchas** — system-specific quirks (iframe handling, grid IDs, etc.)
- **Lessons Learned** — append-only log of past bugs and fixes

Template per `src/workflows/<name>/CLAUDE.md`:

- **What this workflow does** — 1 paragraph
- **Data flow** — arrows showing which systems get touched and why
- **Schema** — pointer to `schema.ts`
- **Gotchas** — workflow-specific quirks (rehire short-circuit, batch mode specifics)
- **Lessons Learned** — append-only

### New: single-page "kernel primer" in docs

`docs/KERNEL.md` (or similar) — a 200-line primer that future Claude sessions read before touching a workflow. Includes:

- What `defineWorkflow` is
- The 5 things `ctx` gives you
- Auth chain semantics (interleaved is the default)
- Batch vs pool modes
- When to reach for escape hatches (`ctx.session`)

Cross-link from every workflow CLAUDE.md: "See `docs/KERNEL.md` before editing."

### Automated freshness checks (stretch)

Stretch goal: a simple `npm run lint:docs` that:
- Greps every CLAUDE.md for references to deleted code (e.g. `WorkflowSession`, `withTrackedWorkflow` outside of kernel-internal files)
- Flags dead code references
- Optionally: git-log-based staleness warnings ("this CLAUDE.md hasn't been touched since 2026-02 but the directory has been edited 12 times since")

Not required for subsystem C completion — could be a follow-up.

## Key decisions for brainstorm

1. **Where does the "kernel primer" live?** `docs/KERNEL.md`? Root `CLAUDE.md`? A new `CLAUDE.md` at `src/core/`?
2. **Append-only Lessons Learned or triaged?** Current pattern is append-only; some entries are stale. Policy question: prune aggressively, or trust readers to sort wheat from chaff?
3. **Consolidate patterns into root CLAUDE.md, or keep per-module for locality?** Per-module wins for "I'm editing UCPath and want UCPath context." Root wins for "I'm starting a new workflow." Need both, probably — define what goes where.
4. **Do we enforce the CLAUDE.md template across modules?** Opinionated template aids consistency but kills organic documentation. Light template (required sections listed) is a reasonable middle.
5. **How do we prevent future drift?** Automated linting (above stretch goal)? Checklist in PRs? Bet-on-discipline?
6. **What happens to the old specs/plans directory?** Does it stay as a historical record, or get archived to a `docs/history/`?

## Scope

### In scope
- Audit every `CLAUDE.md` in the repo
- Rewrite root `CLAUDE.md`: delete outdated sections, add "Writing a new workflow" section
- Update per-system `CLAUDE.md` files to the template
- Update per-workflow `CLAUDE.md` files to the template
- Write `docs/KERNEL.md` primer
- Prune obvious-stale `Lessons Learned` entries (those referring to deleted code)
- Cross-link templates appropriately

### Out of scope
- Automated CLAUDE.md linting tool (stretch; defer to follow-up if wanted)
- Rewriting past specs/plans in `docs/superpowers/` — those are historical artifacts, not living docs
- Enforcing doc format via CI — worth considering but not in scope here

## Dependencies

- **Requires:** B+E, A, and D all landed. This subsystem documents the final state.
- **Blocks:** Nothing. Final subsystem.

## Risk and open questions

1. **If we rewrite root CLAUDE.md aggressively, we lose historical context.** Preserving a "pre-refactor" snapshot somewhere (even a git tag) is prudent.
2. **Lessons Learned sections are valuable** even when stale — they encode past bugs. Pruning carelessly destroys institutional memory.
3. **Templates kill organic documentation.** Heavy-handed templates produce "CLAUDE.md that satisfies the template but doesn't help anyone."
4. **Kernel primer length.** 200 lines may be too long; Claude Code auto-loads root CLAUDE.md but not `docs/KERNEL.md`. If the primer isn't auto-loaded, future sessions won't read it unless explicitly directed. Consider inlining the primer into root CLAUDE.md instead.

## Rough plan shape (for post-brainstorm)

4-5 tasks:

1. Audit: produce `docs/claude-md-audit.md` listing every section of every CLAUDE.md with keep/update/delete/move classification
2. Rewrite root `CLAUDE.md` per classification + add "Writing a new workflow" section
3. Update all per-system `CLAUDE.md` files to the template
4. Update all per-workflow `CLAUDE.md` files to the template
5. Optional: write `docs/KERNEL.md` primer (or inline into root)
6. Tag `subsystem-c-claude-md-conventions-complete`

## Unresolved tension

The kernel's declarative shape is supposed to be self-documenting via TypeScript. If a future Claude reads `defineWorkflow`'s type signature, do they need a CLAUDE.md section explaining it?

**Probably yes**, because:
- Types show signatures, not intent or rationale
- New workflows need a template to copy from — CLAUDE.md is the obvious place
- Gotchas (PeopleSoft iframe, Duo sequencing, grid ID mutation) aren't expressible in types

But this subsystem might be smaller than estimated if the types genuinely do most of the communication work. Revisit after Phase 2 migrations — we'll have 6 worked examples and can judge how much prose each CLAUDE.md actually needs.
