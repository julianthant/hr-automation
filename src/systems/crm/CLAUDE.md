# CRM Module

ACT CRM (Salesforce) automation: employee search, navigation, and field extraction from Visualforce pages.

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

## Gotchas

- Hardcoded column indices in search results: "Offer Sent On" is column index 1
- Date parsing is lenient (`new Date(dateText)`) — silently skips invalid dates
- If all dates are unparseable, throws "No search results found" (misleading)
- `extractField` only works for Visualforce table-based layouts
- Each extraction strategy has 2s timeout before trying next
- `navigateToSection` regex doesn't escape special chars in section names
- `CRM_SECTION_URLS` currently only has "UCPath Entry Sheet" — missing sections fall back to slower click navigation
- Always waits for `networkidle` after navigation (conservative but slower)

## Lessons Learned

*(Add entries here when CRM bugs are fixed — document root cause and fix so the same error never recurs)*
