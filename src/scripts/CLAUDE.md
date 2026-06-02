# Scripts — Categorized Dev & Ops Tools

Scripts are organized by purpose. Workflow-specific dev tools live in their workflow folder, not here.

## Files (per category)

### `selectors/`

- **`catalog.ts`** — Walks every `src/systems/<sys>/selectors.ts`, extracts every exported selector (top-level functions, top-level const arrow functions, and arrow functions nested inside exported object literals like `smartHR.tab.personalData`), emits a `SELECTORS.md` per system. Pure `extractSelectors(filePath, source)` and `renderCatalog(system, records)` are exported for unit tests; `main()` does the I/O. Run with `npm run selectors:catalog`.
- **`search.ts`** — CLI fuzzy search across every system's `SELECTORS.md` and `LESSONS.md`. Thin wrapper around `search-lib.ts`. Run with `npm run selector:search "<intent>"`.
- **`search-lib.ts`** — Pure scoring + index logic. No file I/O. `tokenize`, `scoreItem`, `rank`, `parseSelectorsMarkdown`, `parseLessonsMarkdown` exported for tests.

### `codegen/`

- **`export-schemas.ts`** — Exports workflow Zod input schemas to JSON Schema files under `generated/schemas/`. The script uses an explicit `SCHEMA_REGISTRY` mapping (workflow name -> exported schema), converts with Zod v4 `toJSONSchema({ unrepresentable: "any" })`, and writes one gitignored `*.schema.json` per entry. Pure `exportSchemas(outDir)` is exported for tests. Wired as `npm run schemas:export`.

### `ops/`

- **`clean-tracker.ts`** — Prunes `.tracker/*.jsonl` and `.screenshots/*.png` files older than N days. Flags: `--days N`, `--dir`, `--screenshots-dir`, `--no-screenshots`, `--screenshots-only`. Default cleans both. Wired as `npm run clean:tracker`. Exports `cleanTrackerMain` for tests.
- **`setup.ts`** — First-use environment validation wizard. Fixed checks for `.env` keys (existence only, never values), Node ≥ 26, `tsx`, Playwright chromium cache, `.tracker/` + `.screenshots/` + `~/Downloads/onboarding/` writability, macOS notification capability (warn-only on non-darwin), optional `jq`, and the opt-in Duo SMS passcode path (`checkDuoSmsAccess` — when `HR_AUTOMATION_DUO_SMS=1` on macOS, probes `~/Library/Messages/chat.db` readability and warns if Full Disk Access is missing). Prints `[ok]` / `[warn]` / `[fail]` per check with a fix suggestion. Exits 0 if all pass or only warnings; exits 1 on any failure. Wired as `npm run setup`. **`npm run setup:telegram`** dispatches the interactive Telegram bot wizard via the `--telegram` arg — creates a bot via @BotFather, discovers chat_id from `/getUpdates`, writes both to `.env` (idempotent), sends a confirmation DM. Exports `runAllChecks`, `setupMain`, `checkDuoSmsAccess`, `runTelegramSetup`, `validateBotToken`, `discoverChatId`, `writeEnvVar` for tests.

### `debug/`

- **`kronos.ts`** — Consolidated Kronos dev tool. Authenticates both Old + New Kronos (2 Duos) then dispatches one of three subcommands:
  - `map <eid>` — navigate to both timecard pages, keep open for selector mapping
  - `test <eid>` — run `checkTimecardDates` on both in parallel, dump results
  - `explore <eid>` — open Old Kronos "Go To" menu and dump menu items, then `page.pause()` in both browsers
  - Run with `tsx --env-file=.env src/scripts/debug/kronos.ts <map|test|explore> [<eid>]`. Replaces the prior `kronos-map.ts` / `test-kronos-timecard.ts` / `explore-kronos-selectors.ts` trio.

### `src/workflows/emergency-contact/scripts/` (workflow-specific)

- **`download-roster.ts`** — One-shot SharePoint roster downloader. Wraps `downloadSharePointFile` from [`src/workflows/sharepoint-download/`](../../workflows/sharepoint-download/) (the canonical location as of 2026-04-22) with a CLI front-end. Co-located with emergency-contact because that's this script's primary consumer, but the underlying helper is cross-cutting.
- **`verify-roster.ts`** — One-shot roster verification (without running the workflow). Wraps `verifyBatchAgainstRoster` from `../roster-verify.ts`. Co-located with the workflow because it's the only consumer.

## Conventions

- **Tests mirror source layout one-for-one** (per `tests/CLAUDE.md`). `src/scripts/selectors/catalog.ts` → `tests/unit/scripts/selectors/catalog.test.ts`.
- **Pure logic exported for tests, I/O confined to `main()`.** Every script that has unit tests follows this split — see `selectors/search-lib.ts` (pure index/scoring) vs `selectors/search.ts` (CLI + file I/O).
- **`isMainModule` guard** comes from `src/scripts/main-module.ts` and checks the invoked path plus `.ts`/compiled `.js` basename fallbacks so scripts behave the same under tsx and compiled output. Use that helper before firing `main()`; do not add underscore-prefixed script helpers because the filename architecture guard rejects them.

## Usage

Operational scripts have npm aliases (preferred):

```bash
npm run setup
npm run clean:tracker
npm run schemas:export
npm run selectors:catalog
npm run selector:search "<intent>"
```

Dev tools without npm aliases run via tsx directly:

```bash
# Kronos consolidated dev tool
tsx --env-file=.env src/scripts/debug/kronos.ts map <eid>
tsx --env-file=.env src/scripts/debug/kronos.ts test <eid>
tsx --env-file=.env src/scripts/debug/kronos.ts explore <eid>

# Emergency-contact specific
tsx --env-file=.env src/workflows/emergency-contact/scripts/download-roster.ts "<sp-url>"
tsx --env-file=.env src/workflows/emergency-contact/scripts/verify-roster.ts <batchYaml> <rosterXlsx>
```

## When to Use

- **Selector discovery**: `npm run selector:search` first; if no match, use `debug/kronos.ts explore <eid>` (or `playwright-cli` directly for non-Kronos systems) to map a new selector. After mapping, add to `src/systems/<sys>/selectors.ts` with today's `// verified` date and run `npm run selectors:catalog`.
- **Dashboard testing**: write fake JSONL lines into `.tracker/{workflow}-{YYYY-MM-DD}.jsonl` directly — the dashboard reads files, no script needed.
- **Debugging a Kronos issue in isolation**: `debug/kronos.ts test <eid>` runs the full timecard check without a workflow wrapper.

## Lessons Learned

- **2026-04-18: Reorganized into selectors/codegen/ops/debug subfolders.** The flat layout had grown to 17 files across 6 unrelated concerns. Moved tests in lockstep (per the `tests/CLAUDE.md` mirror convention). Dropped `-cli` suffixes (the folder gives the context). Deleted `eid-manual-lookup.sh` (superseded by the `eid-lookup` workflow), `sep-batch.ts` (later superseded by the dashboard input-run path for separation doc IDs), and `mock-sessions.ts` (used a Windows-only `powershell` PID lookup that fell through to the script's own short-lived PID on macOS — broken in practice). Consolidated `kronos-map.ts` + `test-kronos-timecard.ts` + `explore-kronos-selectors.ts` into one `debug/kronos.ts` with subcommands — they shared 90% of auth setup. Co-located `download-sharepoint-roster.ts` + `verify-batch-against-roster.ts` into `src/workflows/emergency-contact/scripts/` since they're workflow-specific.
- **2026-04-18: Selector intelligence layer landed.** `selectors/catalog.ts` (TS Compiler API walker emitting per-system `SELECTORS.md`) + `selectors/search.ts` (CLI fuzzy search across catalogs + per-system `LESSONS.md`) + `selectors/search-lib.ts` (pure scoring/index logic). The pair plus the per-system `LESSONS.md` / `common-intents.txt` files give future Claude sessions a way to find existing selectors by intent and read past failure lessons before re-mapping. Generated catalog drives `npm run selector:search`; the inline-selector test guard still enforces no inline selectors outside `selectors.ts`.
