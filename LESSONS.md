# Lessons Learned

Cross-codebase patterns and mistakes to avoid. Read this before non-trivial work.

## Selector Mapping

- **Always search before mapping:** `npm run selector:search "<intent>"` first. If found, USE IT — don't remap.
- **Never guess selectors.** Map via `playwright-cli snapshot`, verify with JSDoc + `// verified <date>`, run `npm run selectors:catalog`.
- **Fallback chains for brittle selectors:** When PeopleSoft grid IDs mutate, use up to 6-deep `.or()` chains.
- **Maintain lessons when you learn them:** Before adding a lesson, search the relevant `LESSONS.md` / `CLAUDE.md` for the same topic. Update, merge, or remove stale contradictory guidance instead of adding a redundant entry.

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
- **Multi-daemon dispatch:** Atomic SQLite `UPDATE … RETURNING` claim inside a transaction. Whichever daemon's UPDATE wins grabs the row — dynamic load balancing without a coordinator. The `.queue.jsonl` audit file is informational only.
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
- **Keep lessons current, not append-only.** New entries are fine for genuinely new failure modes, but stale or redundant lessons should be updated, merged, or removed so future sessions do not follow outdated guidance.

## Migrations

- **2026-05-23: Archetype stamping enforced at the type level (Contract 1).** `emitTrackerRow` in `src/tracker/jsonl-io.ts` requires `data: StampedData` (`Record<string, string> & { archetype: RowArchetype }`). Every kernel + control + OCR emit site now routes through it; `trackEvent` / `trackEventForDate` remain only as `@deprecated` shims for the tracker module itself and the `tracked-workflow.ts` SIGINT handler. Control-layer cancel / retry rows inherit archetype from the prior row via `resolveRowArchetype` so they don't drop the row's shape. `resolveRowArchetype` throws on rows with an invalid stamped `data.archetype`; missing archetype falls back to the canonical mapping (`delegate-child` with parent, else `single`). The legacy heuristics (`mode === "prepare"` etc.) are gone. Architecture guard: `tests/unit/architecture/tracker-row-emission.test.ts` (blocks new direct callers + new `appendFileSync` writes to `*.jsonl` paths). Supersedes the 2026-05-17 write-side-contract lesson — that contract is now type-enforced, not convention.

- **2026-05-08: SQLite/JSONL parallel-path parity checklist.** Tier 3's `findPriorEntriesByKey` SQLite migration drifted from its JSONL fallback in two non-obvious ways: (1) JSONL trimmed candidate values via `String(value).trim()`; SQLite used exact `=` until a follow-up wrapped it in `TRIM(...)`. (2) JSONL's date cutoff was local time (`new Date(d + "T00:00:00").getTime()`); SQLite used UTC (`cutoff.toISOString().slice(0, 10)`), shifting the boundary by a day for late-evening queries in negative-UTC zones. Both bugs would silently lose hits in prod without surfacing as test failures (dev data is mostly clean and the timezone-boundary case requires running queries past local midnight UTC ≈ 5pm PT). When migrating any JSONL-walking handler to SQLite, write a parity checklist before shipping: (a) **whitespace** — does the JSONL path call `.trim()` / `.toLowerCase()` / etc on candidate values? Mirror in SQL via `TRIM`, `LOWER`. (b) **timezone** — does any date cutoff use `dateLocal()` / `new Date()` parsing? Mirror in SQL with the same local-time derivation, never `toISOString().slice(0, 10)`. (c) **wildcards** — does the JSONL path use `String.includes`? SQL `LIKE` interprets `%` and `_` as wildcards; escape them via `REPLACE` chains + `ESCAPE` clause if the SQL match should be literal-only. (d) **null vs empty** — JSONL's `entry.data?.[key] === value` treats missing-data and missing-key the same; `json_extract(..., '$.' || @key)` returns `NULL` for both, so `IS NOT NULL` gating before the comparison is fine. (e) **dedup semantics** — JSONL Map walks reduce to "latest per key"; SQL aggregation may need `MAX(ts) GROUP BY key` or a CTE that picks the latest. The Tier 3 Task 7 deviation pivoted to the `items` table specifically because it pre-stores latest-per-(workflow, tracker_date, item_id), eliminating the GROUP BY — but that's not always available; default to "verify the dedup explicitly."

- **2026-05-07: Node 26 floor pinned; better-sqlite3 + picocolors removed.** Project now requires Node ≥26.0.0 (`engines` + `.nvmrc=26.1.0`). Two userland deps replaced by built-ins:
  - `better-sqlite3` → `node:sqlite` via the `src/infra/sqlite/` compat shim. Removes the only native-build dependency from the repo — `npm install` no longer needs `node-gyp` / Xcode CLI tools / Python. `transaction(db, fn)` helper fills the `db.transaction()` gap that `node:sqlite` doesn't expose, and supports nesting via SAVEPOINT (the codebase actually does nest in a few task-store paths, contrary to the plan's original assumption). SQLite engine semantics identical (both libs link the same SQLite); only the JS bindings changed. `setAllowUnknownNamedParameters(true)` is enabled in the wrapper to match better-sqlite3's silent-ignore-extra-params behavior, which is pervasive in the call sites.
  - `picocolors` → `node:util.styleText`. Honors `NO_COLOR` / `FORCE_COLOR` / TTY detection natively.
  Six hand-rolled `AbortController + setTimeout` patterns replaced with `AbortSignal.timeout(ms)` (fetch timeouts) or `node:timers/promises` `setTimeout(ms, value, { signal })` (abortable sleeps). Native TS execution intentionally rejected — codebase uses `.js` extensions in relative imports, and Node 26's strip-types mode does not rewrite them. `tsx` remains the runtime executor; `npm run dashboard:watch` uses `tsx watch` for backend hot-reload. Permission model documented for opt-in sandboxing but not enabled by default. `@types/node` pinned to `^25.6.0` (DefinitelyTyped hadn't published a 26.x series at migration time; 25.6.2 already includes typings for `DatabaseSync`/`StatementSync`, `styleText`, and `node:timers/promises` setTimeout — the typings later tasks needed).
