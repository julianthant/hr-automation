# Scripts — Dev Tools

Development and debugging scripts. These are NOT production workflows — they're for manual testing, selector exploration, and batch operations.

## Files

- `eid-manual-lookup.sh` — Shell script for quick manual EID lookups
- `explore-kronos-selectors.ts` — Opens Kronos browsers and pauses for Playwright Inspector to map selectors
- `kronos-map.ts` — Maps Kronos employee data for batch processing
- `sep-batch.ts` — Batch separations testing tool
- `test-kronos-timecard.ts` — Tests Kronos timecard extraction in isolation
- `clean-tracker.ts` — Prunes `.tracker/*.jsonl` AND `.screenshots/*.png` files older than N days. Flags: `--days N`, `--dir`, `--screenshots-dir`, `--no-screenshots`, `--screenshots-only`. Default behavior cleans both.
- `setup-cli.ts` — First-use environment validation wizard. Runs fixed checks for `.env` keys (existence only, never values), Node ≥ 20, `tsx`, Playwright chromium cache, `.tracker/` + `.screenshots/` + `~/Downloads/onboarding/` writability, macOS notification capability (warn-only on non-darwin), and optional `jq`. Prints `[ok]` / `[warn]` / `[fail]` per check with a fix suggestion. Exits 0 if all pass or only warnings; exits 1 on any failure. Wired as `npm run setup`.

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

*(Add entries here when script-related issues are discovered — document what went wrong and the fix)*
