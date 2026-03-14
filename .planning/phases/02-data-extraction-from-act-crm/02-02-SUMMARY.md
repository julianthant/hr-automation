---
phase: 02-data-extraction-from-act-crm
plan: 02
subsystem: crm
tags: [playwright, visualforce, zod, salesforce, scraping]

requires:
  - phase: 02-01
    provides: "Extraction code with best-guess selectors and Zod schema"
  - phase: 01-auth
    provides: "ACT CRM authentication with Duo MFA"
provides:
  - "Working end-to-end extraction pipeline against live ACT CRM"
  - "Verified Visualforce selectors for UCPath Entry Sheet"
  - "Tightened Zod schema matching real data formats"
  - "URL-based navigation pattern (search and entry sheet)"
affects: [03-ucpath-entry, 04-batch-processing]

tech-stack:
  added: []
  patterns:
    - "URL param navigation instead of UI clicking for speed and reliability"
    - "Visualforce th/td extraction pattern for Salesforce pages"

key-files:
  created: []
  modified:
    - src/crm/search.ts
    - src/crm/navigate.ts
    - src/crm/extract.ts
    - src/workflows/onboarding/extract.ts
    - src/workflows/onboarding/schema.ts
    - src/auth/login.ts
    - tests/unit/schema.test.ts

key-decisions:
  - "URL param navigation over UI clicking -- faster, more reliable (ONB_SearchOnboardings?q=email, ONB_PPSEntrySheet?id=...)"
  - "SSN made optional -- international students may not have SSN at onboarding time"
  - "Visualforce th/td extraction strategy -- labels in th.labelCol, values in sibling td.data2Col"
  - "State constrained to 2-letter code, effectiveDate to MM/DD/YYYY, wage must start with $"

patterns-established:
  - "URL param navigation: when live testing reveals URL patterns, use page.goto() with query params instead of clicking UI elements"
  - "Visualforce extraction: th:has-text(label) → following-sibling::td for Salesforce custom pages"

requirements-completed: [EXTR-01, EXTR-02, EXTR-03, EXTR-04, EXTR-05]

duration: 45min
completed: 2026-03-14
---

# Plan 02-02: Live Selector Discovery Summary

**Verified end-to-end ACT CRM extraction pipeline with URL-based navigation, Visualforce DOM extraction for all 10 fields, and tightened Zod schema matching real data formats**

## Performance

- **Duration:** ~45 min (iterative live testing with Duo MFA)
- **Tasks:** 3 (2 auto + 1 human-verify checkpoint)
- **Files modified:** 7
- **Commits:** 4

## Accomplishments
- All selectors discovered and fixed against live ACT CRM Visualforce pages
- Direct URL navigation for search and entry sheet (no fragile UI clicking)
- Zod schema tightened: state=2-letter, effectiveDate=MM/DD/YYYY, wage=$-prefixed, SSN optional
- Error path verified: non-existent emails produce clean "No search results found"
- Verified across 2 different employee records (one with SSN, one without)

## Task Commits

1. **Task 1: Live selector discovery** - `9e2d168` (fix)
2. **Task 2: Tighten Zod schema** - `52a234e` + `b85b96a` (feat + fix for optional SSN)
3. **Task 3: Error path fix** - `fddc9ff` (fix)

## Files Created/Modified
- `src/crm/search.ts` - URL param search, date-based row selection with name link click
- `src/crm/navigate.ts` - Direct URL navigation via SECTION_URLS map
- `src/crm/extract.ts` - Visualforce th/td extraction strategy
- `src/workflows/onboarding/extract.ts` - FIELD_MAP updated with live labels
- `src/workflows/onboarding/schema.ts` - Tightened validators, optional SSN
- `src/auth/login.ts` - Fixed login button selector
- `tests/unit/schema.test.ts` - 18 tests (5 new for tightened schema + optional SSN)

## Decisions Made
- URL param navigation over UI clicking (per user feedback -- faster and more reliable)
- SSN optional because international students don't have SSN at onboarding time
- Login button targeted by `name="_eventId_proceed"` to avoid matching nav link
- Date column is "Offer Sent On" (index 1), not last column

## Deviations from Plan

### Auto-fixed Issues

**1. Login button selector mismatch**
- **Found during:** Task 1 (live testing)
- **Issue:** `getByRole("button", { name: "LOGIN" })` matched a nav link instead of the submit button
- **Fix:** Target by `button[name="_eventId_proceed"]`
- **Files modified:** src/auth/login.ts

**2. SSN optional (not in original plan)**
- **Found during:** Task 3 (second employee verification)
- **Issue:** International students lack SSN, causing validation failure
- **Fix:** Made SSN optional in Zod schema per user direction
- **Files modified:** src/workflows/onboarding/schema.ts, tests/unit/schema.test.ts

---

**Total deviations:** 2 auto-fixed
**Impact on plan:** Both necessary for correctness. No scope creep.

## Issues Encountered
- Search input hidden behind magnifying glass toggle on homepage -- resolved by using direct URL navigation
- Clicking table row didn't navigate to record -- needed to click name link in first column
- Visualforce DOM uses th/td pairs (not td/td) -- required new extraction strategy

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Extraction pipeline complete and verified against live ACT CRM
- Ready for Phase 3: UCPath data entry using extracted employee data
- URL navigation pattern established for future ACT CRM pages

---
*Phase: 02-data-extraction-from-act-crm*
*Completed: 2026-03-14*
