# General Lessons Learned

This file documents cross-codebase patterns and lessons that apply everywhere. Domain-specific lessons live in local `CLAUDE.md` files (e.g., `src/systems/<system>/CLAUDE.md`, `src/workflows/<workflow>/CLAUDE.md`).

**Read this before any non-trivial work to avoid repeating mistakes.**

## Selector Mapping

- **Always search before mapping:** `npm run selector:search "<intent>"` first. If found, USE IT — don't remap. Reuse saves time and prevents brittle duplication.
- **Never guess selectors:** Map via `playwright-cli snapshot`, verify with JSDoc + `// verified <date>`, run `npm run selectors:catalog`. One wrong selector causes silent failures.
- **Fallback chains for brittle selectors:** When PeopleSoft grid IDs mutate or similar anchors are fragile, use up to 6-deep `.or()` chains (e.g. ID → query selector → index-based → full fallback). Verified dates help identify which fallbacks are current.
- **Lessons over complaints:** When a selector fails for a non-obvious reason (grid mutation, frame nesting, timing), append it to the system's `LESSONS.md` so the next session doesn't relearn it.

## Architecture: Root vs Local

- **Root CLAUDE.md:** Concise navigator. Architecture overview, kernel primer, daemon mode, commands, where-to-find-things. No system-specific details.
- **Local CLAUDE.md:** Source of truth. System gotchas, verified selectors, workflow patterns, testing approach, lessons learned in that domain.
- **When adding documentation:** Ask "Will another system/workflow need this?" If yes, it's shared; goes to root or `docs/engineering/`. If no, it's domain-specific; goes to local CLAUDE.md.

## Shared Code vs Workflow-Local

- **Shared:** Used by 2+ workflows, or by 1 workflow + tracker/dashboard/core/OCR → `src/domain/` or `src/core/`
- **Workflow-local:** Single workflow, never used elsewhere → `src/workflows/<workflow>/`
- **Anti-pattern:** Duplicating a function across two workflows. Refactor to shared before it spreads to three.

## Kernel Patterns

- **Always declare operatorSubject:** Required in new workflows. Used by queue rows, Telegram, toast labels, logs. Prefer EID-based over freeform names.
- **Use ctx.step, not inline error handling:** The kernel wraps your step blocks, screenshots on failure, emits failures correctly. Don't try to handle errors yourself.
- **Live-page probes for dupe-protection:** Don't rely on a tracker-side cache (removed 2026-04-23). Before submitting, check the live page for proof of prior submission (e.g., `findExistingTerminationTransaction`, "no oath signature" sentinel).
- **Test your step names:** Step names are type-narrowed against the `steps` tuple. If you typo a step name, TypeScript catches it before runtime.

## Testing & Guards

- **Architecture tests are non-negotiable:** `npm run test:architecture` enforces no inline selectors, no default exports, lesson format, selector catalog sync. These gates prevent anti-patterns from creeping in.
- **Run before commits:** `npm run test` + `npm run test:architecture` — both must pass.
- **Guard violations block PRs:** If a test fails, fix the code, not the test. The guard is there for a reason.

## Daemon Mode

- **Default for most CLI commands:** `npm run separation <ids>`, `npm run work-study <emplId> <date>`, etc. spawn/reuse long-lived daemons by default.
- **Flags:** `-n, --new` spawns an additional daemon; `-p, --parallel <N>` ensures N are alive before enqueueing.
- **Graceful drain:** `:stop` soft-stops (drains in-flight, re-queues). Use `-- --force` only if you need to mark in-flight as failed and exit immediately.
- **Multi-daemon dispatch:** Atomic fs.mkdir mutex; whichever daemon finishes first claims the next queued row. No coordinator needed.

## Continuous Improvement

- **Update CLAUDE.md after every lesson:** If you discover a non-obvious pattern, fix a selector bug, or get corrected on an anti-pattern, add a dated lesson-learned entry to the relevant CLAUDE.md. These are the only memory between sessions.
- **Bump // verified dates in selectors.ts:** When you re-map or re-verify a selector, update its `// verified YYYY-MM-DD` comment so future sessions know the selector is still current.
- **Append to LESSONS.md files, don't delete:** These are append-only logs. Future work depends on knowing what you learned.

## Common Mistakes to Avoid

- **Inline `page.locator("...")` in system files:** All selectors go through `src/systems/<system>/selectors.ts`. The `inline-selectors` test guard rejects PRs that violate this.
- **Default exports in `src/`:** Use named exports only. Barrel exports are OK (e.g., `export * from "./module.js"`).
- **Reusing Excel trackers as observability:** Dashboard JSONL is the source of truth. Existing xlsx writers are for historical use only; they don't emit tracker events.
- **Guessing at PeopleSoft behavior:** Every PeopleSoft quirk (modal mask, dropdown refresh, grid mutation, etc.) has been hit before. Read the system's `CLAUDE.md` and `LESSONS.md` first.
- **Building your own auth-ready promises:** The kernel's `authChain` (sequential, interleaved, parallel-staggered) handles this. Don't roll your own.
- **Assuming one Duo auth per workflow:** Onboarding runs 2 Duos per session (CRM, then UCPath+I9). Separations runs 4. Check the workflow's `systems` list and `authChain` setting.

## When to Query claude-mem

Before:
- Planning or designing any non-trivial feature/refactor
- Debugging a recurring or non-obvious issue
- Implementing a new workflow, selector, or system driver
- Asking "have we solved this before?" or "how did we handle X last time?"

Use `mem-search` skill (wraps the 3-layer search → timeline → get_observations workflow) for one-off queries; use `knowledge-agent` skill for repeated questions on the same topic in one session.

---

**If you're reading this for the first time in a session:** Great. Now check the local CLAUDE.md files for the domains you're touching, then proceed. Most answers are there.
