# Old Kronos (UKG) Module

Core automation for Old UKG Kronos: employee search, navigation, modal handling, date range setting, and Time Detail report download.

## Before mapping a new selector

1. Run `npm run selector:search "<your intent>"` and review the top matches across all systems.
2. If a selector matches your intent, USE IT — do not map a new one.
3. If [`LESSONS.md`](./LESSONS.md) has a relevant entry, read it first to avoid repeating a known failure.
4. Otherwise, map a new selector following the conventions in [`selectors.ts`](./selectors.ts):
   a. Add the selector function with JSDoc (one-line summary, `@tags`, `verified YYYY-MM-DD`).
   b. Run `npm run selectors:catalog` to regenerate [`SELECTORS.md`](./SELECTORS.md).
   c. If you discovered a non-obvious failure mode along the way, append a lesson to [`LESSONS.md`](./LESSONS.md) following its template.
   d. Verify the inline-selector test still passes: `npx vitest run tests/unit/systems/inline-selectors.test.ts`.

See [`SELECTORS.md`](./SELECTORS.md) for the auto-generated catalog of every selector this module exports.

Example intents for `npm run selector:search`: [`common-intents.txt`](./common-intents.txt).

## Frame Hierarchy

UKG uses deeply nested iframes:
- Main content: `widgetFrame804` (or any `widgetFrame*`) — found via `getGeniesIframe(page)`
- Reports page: three frames:
  - `khtmlReportList` — nav tree (Timecard → Time Detail)
  - `khtmlReportWorkspace` — report options (date range, output format)
  - `khtmlReportingContentIframe` — report content and Run Report button

## `getGeniesIframe` Strategy

1. **SSO re-auth check**: Detects `#ssousername` or `input[name="j_username"]` on page — if found, calls `loginToUKG(page)` to re-authenticate (handles session expiry after page refresh)
2. Try `widgetFrame804` by exact name
3. Check for "network change detected" error in iframe — reloads page if found
4. Fallback: any frame with "genies" in URL
5. Fallback: any frame starting with `widgetFrame`
6. Retry: 15 attempts with 1s waits
7. Last resort: full page reload and retry

## Download Strategy (Dual-Track)

1. **Primary**: Playwright download event listener on page and context
2. **Fallback**: Filesystem diff — snapshots `PATHS.downloadsDir` (`~/Downloads` via `os.homedir()`) and `reportsDir` before/after clicking View Report, finds new `.pdf` files

## Gotchas

- `dismissModal()` must be called before most interactions (UKG modals pop up unexpectedly)
- Date inputs require digit-by-digit typing: triple-click to select, Delete, Home, then type each digit with 100ms delays
- Report status polling: Phase 1 finds Running/Waiting row, Phase 2 polls that row by TR ID until Complete
- First poll attempt may show stale "Complete" row from previous run — must skip and keep refreshing
- Frame names may vary — multiple fallback strategies everywhere
- JS evaluation (`clickInFrames`, `jsClickText`) used extensively because Playwright selectors are unreliable in nested frames
- Filesystem-fallback download path comes from `PATHS.downloadsDir` (`os.homedir() + "/Downloads"`); machine-portable
- **Session expiry on refresh**: If a page refresh causes redirect to SSO login, `getGeniesIframe` detects this and calls `loginToUKG()` to re-authenticate automatically (requires Duo MFA approval)

## Lessons Learned

*(Add entries here when Old Kronos/UKG bugs are fixed — document root cause and fix so the same error never recurs)*
