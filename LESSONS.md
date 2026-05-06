# Lessons Learned

Cross-codebase patterns and mistakes to avoid. Read this before non-trivial work.

## Selector Mapping

- **Always search before mapping:** `npm run selector:search "<intent>"` first. If found, USE IT — don't remap.
- **Never guess selectors.** Map via `playwright-cli snapshot`, verify with JSDoc + `// verified <date>`, run `npm run selectors:catalog`.
- **Fallback chains for brittle selectors:** When PeopleSoft grid IDs mutate, use up to 6-deep `.or()` chains.
- **Append lessons when you learn them:** Non-obvious failures go to the system's `LESSONS.md` so the next session doesn't relearn.

## Shared Code vs Workflow-Local

- **Shared:** Used by 2+ workflows, or 1 workflow + tracker/dashboard/core/OCR → `src/domain/` or `src/core/`
- **Workflow-local:** Single workflow only → `src/workflows/<workflow>/`
- **Anti-pattern:** Duplicating a function across workflows. Refactor to shared before it spreads.

## Kernel Patterns

- **Always declare operatorSubject:** Used by queue rows, Telegram, logs. Prefer EID-based over freeform names.
- **Use ctx.step, not inline error handling:** The kernel wraps your step blocks, screenshots on failure, emits correctly.
- **Live-page probes for dupe-protection:** Check the live page before submitting (e.g., `findExistingTerminationTransaction`, "no oath signature" sentinel). EID match beats name match — Kuali↔UCPath name variants silently miss dupes.
- **Understand authChain:** Onboarding runs 2 Duos (CRM, UCPath+I9). Separations runs 4. Check the workflow's `systems` list.

## Architecture Guards

- **Run before commits:** `npm run test:architecture` enforces no inline selectors, no default exports, lesson format, catalog sync.
- **These gates prevent anti-patterns from creeping in.** Violations block PRs for a reason.

## Daemon Mode

- **Default for most CLI commands.** `-n, --new` spawns additional; `-p, --parallel <N>` ensures N alive.
- **Multi-daemon dispatch:** Atomic fs.mkdir mutex — whichever daemon finishes first claims the next queued row.
- **Graceful drain:** `:stop` soft-stops; `-- --force` marks in-flight failed and exits immediately.

## Common Mistakes

1. **Inline `page.locator("...")` in system files** — all selectors go through `selectors.ts`. The `inline-selectors` test guard rejects this.
2. **Default exports in `src/`** — use named exports only. Barrel exports OK.
3. **Reusing Excel trackers as observability** — dashboard JSONL is the source of truth. Xlsx writers are for historical use only.
4. **Guessing at PeopleSoft behavior** — every quirk has been hit. Read the system's CLAUDE.md first.
5. **Building your own auth-ready promises** — the kernel's `authChain` handles this. Don't roll your own.
6. **Assuming selectors are stable** — map via `playwright-cli`, never guess. Brittle selectors cause silent failures.

## Continuous Improvement

- **Update CLAUDE.md after every lesson.** Bump `// verified` dates in `selectors.ts` when you re-verify. These files are the only memory between sessions.
- **Append to LESSONS.md files, don't delete.** They're append-only logs.
