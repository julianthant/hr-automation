# New Kronos (WFD) Module

Employee search automation for New Kronos (Workforce Dayforce). Much simpler than Old Kronos.

## Files

- `navigate.ts` — `searchEmployee(page, employeeId)`: opens Employee Search sidebar, finds dynamic iframe (`portal-frame-*`), searches by ID, returns `true` if found. `closeEmployeeSearch(page)`: closes sidebar if open
- `index.ts` — Barrel exports; also exports `NEW_KRONOS_URL = "https://ucsd-sso.prd.mykronos.com/wfd/home"`

## Gotchas

- Uses modern `getByRole()` API (more maintainable than CSS selectors)
- Dynamic iframe name: `iframe[name^="portal-frame-"]` (suffix changes per session)
- Checks for "There are no items to display." message to detect no results
- Less defensive than Old Kronos — fewer fallback strategies, lets errors propagate
- No screenshot/debug logging

## Verified Selectors

*(Add selectors here after each playwright-cli mapping session — include date and system)*

## Lessons Learned

*(Add entries here when New Kronos bugs are fixed — document root cause and fix so the same error never recurs)*
