# CRM Module

ACT CRM (Salesforce) automation: employee search, navigation, and field extraction from Visualforce pages.

## Files

- `search.ts` — `searchByEmail(page, email)` (URL-based, never logs email for PII protection), `selectLatestResult(page)` (picks row with latest "Offer Sent On" date)
- `navigate.ts` — `navigateToSection(page, sectionName)` (direct URL preferred via `CRM_SECTION_URLS` config, falls back to clicking links/tabs)
- `extract.ts` — `extractField(page, label)` (strategy-based: Visualforce `th.labelCol` → `td.data2Col` sibling, fallback to generic `td` sibling via XPath)
- `selectors.ts` — **Selector registry** (Subsystem A). Grouped: `search`, `record`, `sectionNav`.
- `types.ts` — `ExtractionError` class with optional `failedFields` array
- `index.ts` — Barrel exports (includes `crmSelectors` registry barrel)

## Before mapping a new selector

1. Run `npm run selector:search "<your intent>"` and review the top matches across all systems.
2. If a selector matches your intent, USE IT — do not map a new one.
3. If [`LESSONS.md`](./LESSONS.md) has a relevant entry, read it first to avoid repeating a known failure.
4. Otherwise, map a new selector following the conventions in [`selectors.ts`](./selectors.ts):
   a. Add the selector function with JSDoc (one-line summary, `@tags`, `verified YYYY-MM-DD`).
   b. Run `npm run selectors:catalog` to regenerate [`SELECTORS.md`](./SELECTORS.md).
   c. If you discovered a non-obvious failure mode along the way, append a lesson to [`LESSONS.md`](./LESSONS.md) following its template.
   d. Verify the inline-selector test still passes: `node --import tsx/esm --test tests/unit/systems/inline-selectors.test.ts`.

See [`SELECTORS.md`](./SELECTORS.md) for the auto-generated catalog of every selector this module exports.

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

All Playwright selectors for this system live in [`selectors.ts`](./selectors.ts).
See that file's `search` / `record` / `sectionNav` groups and the `// verified`
dates on each entry.

**Do not add inline selectors outside `selectors.ts`.** The
[`tests/unit/systems/inline-selectors.test.ts`](../../../tests/unit/systems/inline-selectors.test.ts)
guard will reject PRs that do. Compound paths like `row.locator("td").nth(1)`
(where only the row comes from the registry) are whitelisted via end-of-line
`// allow-inline-selector` comments.

### Record page field labels (Visualforce) — verified 2026-04-14
`record.thLabelFollowingTd(page, label)` and `record.tdLabelFollowingTd(page,
label)` work for any of these known labels:
`Process Stage`, `Employee First/Middle/Last Name`, `Personal Email Address`,
`Address Line 1/2`, `City`, `State`, `Postal Code`, `Hiring Supervisor
First/Last Name`, `First Day of Service (Effective Date)`, `Appointment
(Expected Job) End Date`, `Department` (parse parens → `"DEPT NAME
(000412)"`), `Hire Type`, `Appointment Type`, `Recruitment Number`, `Title
Code/Payroll Title`, `Position Number`, `Working Title`, `FLSA Exemption
Status`, `Union Representation`, `Pay Cycle`, `Pay Rate`, `Benefits
Eligibility`, `Department HR Rep Name`, `HR Contact Phone Number`, `Offer
Letter Acceptance Deadline`, `Date Signed`.

### iDocs PDF viewer (inside record page) — 2026-04-14
- Host: `crickportal-ext.bfs.ucsd.edu` (separate from `act-crm.my.site.com`, but cookies ride along from the Canvas iframe load)
- Viewer iframe URL pattern: `https://crickportal-ext.bfs.ucsd.edu/iDocsForSalesforce/Content/pdfjs/web/PDFjsViewer.aspx?h=<hash>&c=<totalCount>` — find via `page.frames().find(f => f.url().includes("crickportal-ext.bfs.ucsd.edu") && f.url().includes("/pdfjs/web/PDFjsViewer"))`
- **Direct PDF fetch** (preferred): `https://crickportal-ext.bfs.ucsd.edu/iDocsForSalesforce/iDocsForSalesforceDocumentServer?i=<0-based-idx>&h=<hash>` via `page.context().request.get(url)` — returns `application/pdf` with `Content-Disposition: inline; filename=iDocs-....pdf`
- PDF.js UI controls (only relevant for manual exploration): `#docNum` (current doc #, 1-based), `#nextDoc`/`#previousDoc`, `#secondaryToolbarToggle` (Tools menu — no download entry, so direct fetch is required)

## Lessons Learned

*(Add entries here when CRM bugs are fixed — document root cause and fix so the same error never recurs)*
