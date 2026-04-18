# Scripts — Dev Tools

Development and debugging scripts. These are NOT production workflows — they're for manual testing, selector exploration, and batch operations.

## Files

- `eid-manual-lookup.sh` — Shell script for quick manual EID lookups
- `explore-kronos-selectors.ts` — Opens Kronos browsers and pauses for Playwright Inspector to map selectors
- `kronos-map.ts` — Maps Kronos employee data for batch processing
- `sep-batch.ts` — Batch separations testing tool
- `test-kronos-timecard.ts` — Tests Kronos timecard extraction in isolation
- `clean-tracker.ts` — Prunes `.tracker/*.jsonl` AND `.screenshots/*.png` files older than N days. Flags: `--days N`, `--dir`, `--screenshots-dir`, `--no-screenshots`, `--screenshots-only`. Default behavior cleans both. Wired as `npm run clean:tracker`. Exports `cleanTrackerMain` for testability.
- `setup-cli.ts` — First-use environment validation wizard. Runs fixed checks for `.env` keys (existence only, never values), Node ≥ 20, `tsx`, Playwright chromium cache, `.tracker/` + `.screenshots/` + `~/Downloads/onboarding/` writability, macOS notification capability (warn-only on non-darwin), and optional `jq`. Prints `[ok]` / `[warn]` / `[fail]` per check with a fix suggestion. Exits 0 if all pass or only warnings; exits 1 on any failure. Wired as `npm run setup`.
- `selectors-catalog.ts` — Walks every `src/systems/<sys>/selectors.ts` and writes a `SELECTORS.md` catalog per system. Pure `extractSelectors(filePath, source)` and `renderCatalog(system, records)` are exported for unit tests; `main()` does the I/O. Run with `npm run selectors:catalog`.
- `selector-search.ts` — CLI fuzzy search across every system's `SELECTORS.md` and `LESSONS.md`. Thin wrapper around `selector-search-lib.ts` (pure scoring/index logic, exported for tests). Run with `npm run selector:search "<intent>"`.
- `selector-search-lib.ts` — Pure scoring + index logic for `selector-search`. No file I/O. `tokenize`, `scoreItem`, `rank`, `parseSelectorsMarkdown`, `parseLessonsMarkdown` are all exported.
- `new-workflow.ts` — Scaffolder for a new kernel workflow. Generates `schema.ts`, `workflow.ts`, `index.ts`, and a templated `CLAUDE.md` (with deep links to per-system LESSONS/SELECTORS/common-intents based on `--systems crm,ucpath` flag). Pure helpers `kebabToPascal`, `kebabToCamel`, `parseArgv`, and `scaffold` are exported for unit tests; `main()` does the I/O. Wired as `npm run new:workflow`.
- `export-schemas.ts` — Walks every `src/workflows/*/schema.ts`, exports each Zod input schema to a JSON Schema file under `out/schemas/`. Pure `exportSchemas(outDir)` is exported for tests. Wired as `npm run schemas:export`.
- `scheduler-cli.ts` — CRUD CLI for cron-style scheduled workflow runs (list/create/delete/run-now). Wired as `npm run schedule`. Exports `schedulerCliMain` for testability.
- `download-sharepoint-roster.ts` — Manual one-shot SharePoint roster downloader. Wraps `downloadSharePointFile` from `src/workflows/emergency-contact/sharepoint-download.ts` with a CLI front-end. Dev tool only.
- `verify-batch-against-roster.ts` — Manual one-shot roster verification (without running the workflow). Wraps `verifyBatchAgainstRoster` from `src/workflows/emergency-contact/roster-verify.ts`. Dev tool only.
- `mock-sessions.ts` — Writes synthetic session-event lines into `.tracker/sessions.jsonl` for offline dashboard demos. Useful when iterating on `SessionPanel` UI without launching real workflows. (Note: `rebuildSessionState` dims workflows whose start-PID is dead — generated PIDs will fall through to inactive.)

## Usage

Run directly with tsx:
```bash
tsx --env-file=.env src/scripts/<script>.ts
```

## When to Use

- **Selector discovery**: Use `explore-kronos-selectors.ts` to launch headed browsers, then switch to `playwright-cli` for snapshot/mapping
- **Dashboard testing**: Write fake JSONL lines directly into `.tracker/{workflow}-{YYYY-MM-DD}.jsonl`, `-logs.jsonl`, and `.tracker/sessions.jsonl` — the dashboard reads these files, no script needed
- **Debugging**: Use individual test scripts to isolate a specific system interaction

## Lessons Learned

- **2026-04-18: Selector intelligence layer landed.** `selectors-catalog.ts` (TS Compiler API walker emitting per-system `SELECTORS.md`) + `selector-search.ts` (CLI fuzzy search across catalogs + per-system `LESSONS.md`) + `selector-search-lib.ts` (pure scoring/index logic). The pair plus the per-system `LESSONS.md` / `common-intents.txt` files give future Claude sessions a way to find existing selectors by intent and read past failure lessons before re-mapping. Generated catalog drives `npm run selector:search`; the inline-selector test guard still enforces no inline selectors outside `selectors.ts`. The `new-workflow.ts` scaffolder gained a `--systems crm,ucpath` flag and embeds links to those systems' LESSONS/SELECTORS/common-intents in the generated `CLAUDE.md` so the operator scans before mapping.
