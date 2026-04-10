# CRM Module

ACT CRM (Salesforce) automation: employee search, navigation, and field extraction from Visualforce pages.

## Files

- `search.ts` — `searchByEmail(page, email)` (URL-based, never logs email for PII protection), `selectLatestResult(page)` (picks row with latest "Offer Sent On" date)
- `navigate.ts` — `navigateToSection(page, sectionName)` (direct URL preferred via `CRM_SECTION_URLS` config, falls back to clicking links/tabs)
- `extract.ts` — `extractField(page, label)` (strategy-based: Visualforce `th.labelCol` → `td.data2Col` sibling, fallback to generic `td` sibling via XPath)
- `types.ts` — `ExtractionError` class with optional `failedFields` array
- `index.ts` — Barrel exports

## Gotchas

- Hardcoded column indices in search results: "Offer Sent On" is column index 1
- Date parsing is lenient (`new Date(dateText)`) — silently skips invalid dates
- If all dates are unparseable, throws "No search results found" (misleading)
- `extractField` only works for Visualforce table-based layouts
- Each extraction strategy has 2s timeout before trying next
- `navigateToSection` regex doesn't escape special chars in section names
- `CRM_SECTION_URLS` currently only has "UCPath Entry Sheet" — missing sections fall back to slower click navigation
- Always waits for `networkidle` after navigation (conservative but slower)

## Verified Selectors

*(Add selectors here after each playwright-cli mapping session — include date and system)*

## Lessons Learned

*(Add entries here when CRM bugs are fixed — document root cause and fix so the same error never recurs)*
