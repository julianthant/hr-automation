# Kuali Module

Kuali Build separation form automation: extraction and form filling for employee termination workflows.

## Files

- `navigate.ts` — All functions:
  - `openActionList(page)` — navigates to Kuali space, clicks Action List
  - `clickDocument(page, docNumber)` — finds and clicks document link
  - `extractSeparationData(page)` → `KualiSeparationData` (name, EID, dates, termination type, location)
  - `isVoluntaryTermination(type)` — returns `false` for "Never Started Employment" and "Graduated/No longer a Student" (involuntary), `true` for all others
  - `mapTerminationToUCPathReason(type)` — maps Kuali types to UCPath codes (e.g., "Graduated/No longer a Student" → "No Longer Student")
  - `fillTimekeeperTasks(page, name)` — checks acknowledgment, fills timekeeper name
  - `fillFinalTransactions(page, opts)` — fills termination date, department (combobox best-match), payroll title code/title
  - `fillTransactionResults(page, transactionNumber)` — checks submitted checkbox, fills txn number, selects "Does not need Final Pay" radio
  - `fillTimekeeperComments(page, comments)` — fills comments textbox
  - `clickSave(page)` — scrolls to top, targets navbar save button (3-deep `.or()` chain from the registry), waits for network idle
- `selectors.ts` — **Selector registry** (Subsystem A). Grouped: `actionList`, `separationForm`, `timekeeperTasks`, `finalTransactions`, `transactionResults`, `save`.
- `index.ts` — Barrel exports (includes `kualiSelectors` registry barrel)

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

- Hardcoded Kuali space ID: `https://ucsd.kualibuild.com/build/space/5e47518b90adda9474c14adb`
- Uses `getByRole("textbox", { name: "exact label*" })` extensively — brittle if labels change
- Department combobox uses best-effort case-insensitive substring match (skips `"- - -"` option)
- Type of Termination extracted via `.evaluate()` on combobox (gets visible text, not internal value)
- Location field is optional — 3s timeout, silent failure
- "Does not need Final Pay (student employee)" is hardcoded — assumes all separations are students
- Throws generic `Error` for missing documents (not custom error class)
- **`clickSave` targets navbar**: Scrolls to top first, then targets `[class*="action-bar"] button:has-text("Save")` or `nav button:has-text("Save")` before falling back to generic `button[name="Save"]` — avoids clicking wrong save button in modals or other form sections
- `fillTransactionResults` fills fields only — does NOT save. Must call `clickSave()` separately after all form sections are filled

## Gotchas (Additional)

- **Date field verification after fill** — `updateLastDayWorked`, `updateSeparationDate`, and `fillFinalTransactions` termination date fields must verify the value after fill. Kuali date inputs sometimes don't accept the value on first attempt. If the readback doesn't match, retry using `type()` (character-by-character) instead of `fill()`.
- **clickSave false-positive error detection** — Removed overly aggressive error detection from `clickSave` that was triggering on benign page elements. The save button click + network idle wait is sufficient confirmation.

## Verified Selectors

All Playwright selectors for this system live in [`selectors.ts`](./selectors.ts),
grouped by form section. The `save.navbarSaveButton` entry uses a 3-deep
`.or()` fallback chain (action-bar → nav → role-based) — preserved verbatim
from the prior inline implementation.

**Do not add inline selectors outside `selectors.ts`.** The
[`tests/unit/systems/inline-selectors.test.ts`](../../../tests/unit/systems/inline-selectors.test.ts)
guard will reject PRs that do. The `deptCombo.locator("option")` enumeration
inside `fillFinalTransactions` (for best-match department selection) is
whitelisted via end-of-line `// allow-inline-selector`.

## Lessons Learned

- **2026-04-10: Date fields not accepting fill()** — Kuali date inputs occasionally ignore Playwright's `fill()` call. The input appears filled visually but the internal value doesn't update, causing downstream date mismatches. Fix: after every date fill, read back the input value and compare. If mismatch, clear and retry with `type()` which sends individual keystrokes. Always verify date fields after filling.
- **2026-04-10: clickSave false error detection** — `clickSave` had error-checking logic that matched benign DOM elements as errors, causing the workflow to report "save failed" when the save actually succeeded. Removed the false-positive checks. The save is confirmed by waiting for network idle after clicking.
