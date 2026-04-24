# Scripts — Categorized Dev & Ops Tools

Scripts are organized by purpose. Workflow-specific dev tools live in their workflow folder, not here.

## Layout

```
src/scripts/
├── selectors/        ← selector intelligence tooling
│   ├── catalog.ts        — TS Compiler API walker → per-system SELECTORS.md
│   ├── search.ts         — CLI fuzzy search across SELECTORS.md + LESSONS.md
│   └── search-lib.ts     — pure scoring/index logic (tested in isolation)
├── codegen/          ← code generators
│   ├── new-workflow.ts   — scaffolds a new kernel workflow's 5 canonical files
│   └── export-schemas.ts — per-workflow Zod → JSON Schema export to schemas/
├── ops/              ← operational tooling
│   ├── clean-tracker.ts  — prunes .tracker JSONL + .screenshots PNGs
│   └── setup.ts          — first-use environment validation wizard
└── debug/            ← manual one-off dev tools
    └── kronos.ts         — auth both Kronos systems + map/test/explore subcommands

src/workflows/emergency-contact/scripts/   ← workflow-specific dev tools
├── download-roster.ts    — manual SharePoint roster fetch
└── verify-roster.ts      — verify a batch YAML against a local roster
```

## Files (per category)

### `selectors/`

- **`catalog.ts`** — Walks every `src/systems/<sys>/selectors.ts`, extracts every exported selector (top-level functions, top-level const arrow functions, and arrow functions nested inside exported object literals like `smartHR.tab.personalData`), emits a `SELECTORS.md` per system. Pure `extractSelectors(filePath, source)` and `renderCatalog(system, records)` are exported for unit tests; `main()` does the I/O. Run with `npm run selectors:catalog`.
- **`search.ts`** — CLI fuzzy search across every system's `SELECTORS.md` and `LESSONS.md`. Thin wrapper around `search-lib.ts`. Run with `npm run selector:search "<intent>"`.
- **`search-lib.ts`** — Pure scoring + index logic. No file I/O. `tokenize`, `scoreItem`, `rank`, `parseSelectorsMarkdown`, `parseLessonsMarkdown` exported for tests.

### `codegen/`

- **`new-workflow.ts`** — Scaffolder for a new kernel workflow. Generates `schema.ts`, `workflow.ts`, `config.ts`, `index.ts`, and a templated `CLAUDE.md` with deep links to per-system LESSONS/SELECTORS/common-intents based on the `--systems crm,ucpath` flag. Pure helpers `kebabToPascal`, `kebabToCamel`, `parseArgv`, `scaffold` exported for tests. Wired as `npm run new:workflow`.
- **`export-schemas.ts`** — Walks every `src/workflows/*/schema.ts`, exports each Zod input schema to a JSON Schema file under `schemas/`. Pure `exportSchemas(outDir)` exported for tests. Wired as `npm run schemas:export`.

### `ops/`

- **`clean-tracker.ts`** — Prunes `.tracker/*.jsonl` and `.screenshots/*.png` files older than N days. Flags: `--days N`, `--dir`, `--screenshots-dir`, `--no-screenshots`, `--screenshots-only`. Default cleans both. Wired as `npm run clean:tracker`. Exports `cleanTrackerMain` for tests.
- **`setup.ts`** — First-use environment validation wizard. Fixed checks for `.env` keys (existence only, never values), Node ≥ 20, `tsx`, Playwright chromium cache, `.tracker/` + `.screenshots/` + `~/Downloads/onboarding/` writability, macOS notification capability (warn-only on non-darwin), optional `jq`. Prints `[ok]` / `[warn]` / `[fail]` per check with a fix suggestion. Exits 0 if all pass or only warnings; exits 1 on any failure. Wired as `npm run setup`.

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
- **`isMainModule` guard** at the bottom uses a three-way check (`import.meta.url` match, `.ts` filename match, `.js` filename match) so the script behaves the same when run via tsx or compiled output, and is safe to import from tests without firing `main()`.

## Usage

Operational scripts have npm aliases (preferred):

```bash
npm run setup
npm run clean:tracker
npm run schemas:export
npm run new:workflow -- <name> [--systems sys1,sys2]
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

- **2026-04-18: Reorganized into selectors/codegen/ops/debug subfolders.** The flat layout had grown to 17 files across 6 unrelated concerns. Moved tests in lockstep (per the `tests/CLAUDE.md` mirror convention). Dropped `-cli` suffixes (the folder gives the context). Deleted `eid-manual-lookup.sh` (superseded by the `eid-lookup` workflow), `sep-batch.ts` (Commander already supports the batch case via `npm run separation 1234 5678`), and `mock-sessions.ts` (used a Windows-only `powershell` PID lookup that fell through to the script's own short-lived PID on macOS — broken in practice). Consolidated `kronos-map.ts` + `test-kronos-timecard.ts` + `explore-kronos-selectors.ts` into one `debug/kronos.ts` with subcommands — they shared 90% of auth setup. Co-located `download-sharepoint-roster.ts` + `verify-batch-against-roster.ts` into `src/workflows/emergency-contact/scripts/` since they're workflow-specific.
- **2026-04-18: Selector intelligence layer landed.** `selectors/catalog.ts` (TS Compiler API walker emitting per-system `SELECTORS.md`) + `selectors/search.ts` (CLI fuzzy search across catalogs + per-system `LESSONS.md`) + `selectors/search-lib.ts` (pure scoring/index logic). The pair plus the per-system `LESSONS.md` / `common-intents.txt` files give future Claude sessions a way to find existing selectors by intent and read past failure lessons before re-mapping. Generated catalog drives `npm run selector:search`; the inline-selector test guard still enforces no inline selectors outside `selectors.ts`. The `codegen/new-workflow.ts` scaffolder gained a `--systems crm,ucpath` flag and embeds links to those systems' LESSONS/SELECTORS/common-intents in the generated `CLAUDE.md` so the operator scans before mapping.
