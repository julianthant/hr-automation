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
- `index.ts` — Barrel exports

## Gotchas

- Hardcoded Kuali space ID: `https://ucsd.kualibuild.com/build/space/5e47518b90adda9474c14adb`
- Uses `getByRole("textbox", { name: "exact label*" })` extensively — brittle if labels change
- Department combobox uses best-effort case-insensitive substring match (skips `"- - -"` option)
- Type of Termination extracted via `.evaluate()` on combobox (gets visible text, not internal value)
- Location field is optional — 3s timeout, silent failure
- "Does not need Final Pay (student employee)" is hardcoded — assumes all separations are students
- Throws generic `Error` for missing documents (not custom error class)
