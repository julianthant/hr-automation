# I9 Module

Automates I9 Complete (Tracker I-9 by Mitratech) for employment verification: login, employee creation, and search.

## Files

- `login.ts` — `loginToI9(page)`: email/password auth (no Duo MFA), auto-appends `@ucsd.edu` if needed, dismisses training notification popup after login
- `create.ts` — `createI9Employee(page, input)`: fills profile form, saves, selects "Remote - Section 1 Only", fills start date, creates I-9 record. Returns `I9Result` with `profileId` extracted from URL
- `search.ts` — `searchI9Employee(page, criteria)`: flexible search by lastName/firstName/ssn/profileId/employeeId, parses grid results (9 columns)
- `types.ts` — `I9EmployeeInput`, `I9Result`, `I9SearchCriteria`, `I9SearchResult`
- `index.ts` — Barrel exports

## SSN Format Inconsistency

- **Create** (`I9EmployeeInput.ssn`): 9 digits, NO dashes — `"123456789"`
- **Search** (`I9SearchCriteria.ssn`): WITH dashes — `"123-45-6789"`

## Gotchas

- Login detects success via domain change: `stse.i9complete.com` → `wwwe.i9complete.com`
- Training notification popup appears post-login — must dismiss with 2-step click (gracefully handles if absent)
- Worksite dropdown options formatted as `6-{deptNum} DESCRIPTION` — matched via regex
- If no worksite matches department number, throws before saving (manual recovery needed)
- Profile ID extracted from URL pattern `/employee/profile/{id}` after save
- Grid parsing: last `.getByRole("grid")` in dialog is results, earlier grids are headers
- Search button uses direct selector `#divSearchOptions` (not accessible role)
- Returns `I9Result` error object on validation failure (doesn't throw)
