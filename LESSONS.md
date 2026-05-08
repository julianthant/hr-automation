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

## Migrations

- **2026-05-07: Node 26 floor pinned; better-sqlite3 + picocolors removed.** Project now requires Node ≥26.0.0 (`engines` + `.nvmrc=26.1.0`). Two userland deps replaced by built-ins:
  - `better-sqlite3` → `node:sqlite` via the `src/infra/sqlite/` compat shim. Removes the only native-build dependency from the repo — `npm install` no longer needs `node-gyp` / Xcode CLI tools / Python. `transaction(db, fn)` helper fills the `db.transaction()` gap that `node:sqlite` doesn't expose, and supports nesting via SAVEPOINT (the codebase actually does nest in a few task-store paths, contrary to the plan's original assumption). SQLite engine semantics identical (both libs link the same SQLite); only the JS bindings changed. `setAllowUnknownNamedParameters(true)` is enabled in the wrapper to match better-sqlite3's silent-ignore-extra-params behavior, which is pervasive in the call sites.
  - `picocolors` → `node:util.styleText`. Honors `NO_COLOR` / `FORCE_COLOR` / TTY detection natively.
  Six hand-rolled `AbortController + setTimeout` patterns replaced with `AbortSignal.timeout(ms)` (fetch timeouts) or `node:timers/promises` `setTimeout(ms, value, { signal })` (abortable sleeps). Native TS execution intentionally rejected — codebase uses `.js` extensions in relative imports, and Node 26's strip-types mode does not rewrite them. `tsx` remains the runtime executor; `npm run dashboard:watch` uses `tsx watch` for backend hot-reload. Permission model documented for opt-in sandboxing but not enabled by default. Full prefer-this-over-that table in root `CLAUDE.md` "Node 26 conventions" section. `@types/node` pinned to `^25.6.0` (DefinitelyTyped hadn't published a 26.x series at migration time; 25.6.2 already includes typings for `DatabaseSync`/`StatementSync`, `styleText`, and `node:timers/promises` setTimeout — the typings later tasks needed).
