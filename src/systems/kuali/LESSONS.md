# kuali — Selector Lessons

Structured record of selector mistakes and their fixes. Future Claude sessions should read this BEFORE re-mapping a selector. Before adding an entry, search for related guidance and update/merge stale or contradictory lessons; add a new bottom entry only for a genuinely new failure mode.

Each entry has the same shape so `npm run selector:search` can index it. Required fields: **Tried**, **Failed because**, **Fix**, **Tags**. Optional: **Selector** (if there's a registry entry), **References**.

---

## 2026-04-10 — Date inputs silently ignore `fill()`

**Tried:** Calling `dateInput.fill(value)` and moving on (Last Day Worked, Separation Date, Termination Effective Date).
**Failed because:** Kuali date inputs occasionally accept the value visually but fail to update the internal model. Downstream date comparisons then mismatch silently and the workflow saves stale data.
**Fix:** Read back the input value after every date `fill()`. If the readback does not match, clear and retry with `type()` (character-by-character keystrokes). Always verify date fields after filling. Helpers `updateLastDayWorked`, `updateSeparationDate`, and `fillFinalTransactions` in `navigate.ts` already implement this pattern.
**Selector:** `separationForm.lastDayWorked`, `separationForm.separationDate`, `finalTransactions.terminationEffDate` in `selectors.ts`
**Tags:** date, input, fill, type, retry, verify, separation

## 2026-04-10 — `clickSave` reported false errors via overly aggressive selectors

**Tried:** Adding generic error-detection selectors after `clickSave` to surface validation failures (looked for things like `.error`, `[role="alert"]`).
**Failed because:** Kuali pages contain benign DOM elements that match those generic selectors (header banners, success toasts shaped like alerts). The detector flagged saves as failed even when the network indicated success.
**Fix:** Removed the false-positive selectors. The save click + `waitForLoadState("networkidle")` is sufficient confirmation. If you need explicit error detection, anchor on a Kuali-specific class like `.action-bar .alert-error` rather than generic role selectors.
**Selector:** `save.navbarSaveButton` in `selectors.ts`
**Tags:** save, click, error, false-positive, alert, network

## 2026-04-10 — Wrong Save button when modals are open

**Tried:** `getByRole("button", { name: "Save" })` for the navbar save.
**Failed because:** Kuali modals frequently render their own Save button, and the role-based selector matches the modal save first when the modal is open. Clicking that submits the modal instead of the form.
**Fix:** Scroll to the top of the page first, then target the navbar via `[class*="action-bar"] button:has-text("Save")` or `nav button:has-text("Save")`, with the role-based selector only as the third fallback. Encoded as the 3-deep `.or()` chain in `save.navbarSaveButton`.
**Selector:** `save.navbarSaveButton` in `selectors.ts`
**Tags:** save, navbar, modal, fallback, scroll, button

## 2026-06-15 — Action List multi-doc enumeration is UNVERIFIED against live DOM

**Tried:** Added `actionList.docLinks(page)` (`page.getByRole("link", { name: /^\s*\d+\s*$/ })`) to enumerate ALL pending Action List documents, plus `listActionListSeparations(page)` in `navigate.ts` (reads `allTextContents()`, trims, de-dupes, keeps numeric-only names). Used by the read-only live test `tests/live/separations-collect.test.ts`.
**Failed because:** Not yet a failure — but it is NOT live-verified. The existing single-doc `docLink` matches one known doc number; this generalization ASSUMES every pending Action List row exposes its document number as the accessible name of a `link` whose text is a bare run of digits, and that nav / action / pagination links carry word labels (so the numeric filter excludes them). That assumption is derived from the `docLink` pattern + Kuali Build conventions, not confirmed on a live page (Duo MFA is manual, so the selector couldn't be mapped via `playwright-cli` in the session that added it). If Kuali renders doc numbers as non-link cells, prefixes them (e.g. `#1234`), or uses a different role, enumeration returns the wrong set.
**Fix:** When you next run the live test (`npm run test:live` with creds + `.auth/duo-webauthn.json`), snapshot the Action List, confirm `docLinks` matches exactly the pending-document rows (count + numbers), then bump its JSDoc comment from `// NEEDS LIVE VERIFICATION` to `// verified <date>` in `selectors.ts` and re-run `npm run selectors:catalog`. If the assumption is wrong, remap against the live DOM (compound row locator scoped to the Action List table) and update both the selector and this lesson.
**Selector:** `actionList.docLinks` in `selectors.ts` (consumed by `listActionListSeparations` in `navigate.ts`)
**Tags:** action-list, document, links, enumerate, pending, verify, separation, kuali

## 2026-06-17 — Action List `clickDocument` only searched the first page

**Tried:** `clickDocument(page, docNumber)` located the doc with `actionList.docLink` (an UNANCHORED `new RegExp(docNumber)`) and threw `Document #X not found in Action List` when `count() === 0`, reading only the currently-displayed Action List page.
**Failed because:** The Action List paginates at 25 rows/page (footer "N-M of T"; live: "1-25 of 97" across 4 pages) sorted by Created date, so a target doc frequently is NOT on the first page — the single-page check threw a false "not found" for any doc on page 2+.
**Fix:** `clickDocument` now filters via the Action List's own **search box** (`actionList.searchInput` + `actionList.searchGoButton`) instead of paging: type the doc number → click GO → click the matching row. Verified live (doc on page 4 found instantly; searching an absent id returns 0 rows → genuine "not found"). Two gotchas confirmed live and handled: (1) there are **two** "Search" textboxes — the Action List one is scoped to `.kp-input-group:has(.kp-input-button-right)` (the global nav search top-right has no GO button); (2) Kuali search is **substring** based — `"414"` returns 4140–4149 — so `docLink` is now **anchored** (`^\s*<n>\s*$`) to guarantee the exact row, never a longer id that contains it. (A prior revision in this session tried a page-through loop with a `nextPage` arrow selector + `MAX_ACTION_LIST_PAGES` cap; the search box is simpler and was kept instead.)
**Selector:** `actionList.searchInput`, `actionList.searchGoButton`, `actionList.docLink` in `selectors.ts` (consumed by `clickDocument` in `navigate.ts`)
**Tags:** action-list, search, go, document, clickDocument, anchored, substring, separation, kuali

## 2026-06-16 — Kuali form inputs return whitespace-padded values

**Tried:** Returning each extracted field from `extractSeparationData` (`navigate.ts`) raw, straight from `.inputValue()` / the `.evaluate()` combobox read, then passing `eid` into UCPath person search and `SeparationDataSchema`.
**Failed because:** Kuali form inputs come back whitespace-padded. The live read-only test (`tests/live/separations-collect.test.ts`, doc #4241) extracted an EID of `" 10772489"` (leading space) and a Location of `"Catering "` (trailing space) — correct digits/text, but the stray whitespace fails `SeparationDataSchema`'s `eid: ^\d{5,}$` and could break the vol/invol exact-match on `terminationType` (`INVOLUNTARY_TYPES.includes(...)`). This is a latent PRODUCTION bug, not just test strictness.
**Fix:** `.trim()` every extracted string field in `extractSeparationData` before returning the `KualiSeparationData` (`employeeName`, `eid`, `lastDayWorked`, `separationDate`, `terminationType`, `location`). For `terminationType` the in-page `.evaluate()` stays simple — trim the returned string in TS. This is normalization of the SAME value, not a cross-source correction: do NOT add a Workforce/name-search fallback to "fix" a wrong EID — a wrong Kuali EID must still fail loudly (see separations workflow CLAUDE.md "Wrong Kuali EID should fail loudly").
**Tags:** extract, eid, whitespace, trim, inputValue, schema, separation, kuali

## 2026-06-22 — Final Transactions department select must pick by INDEX, not `{ label }` (ISS-B05)

**Tried:** `fillFinalTransactions` (`navigate.ts`) read the department `<select>` options via `allTextContents()`, found the best case-insensitive substring match, then selected it with `deptCombo.selectOption({ label: bestMatch }, { timeout: 5_000 })` — passing the RAW option text straight back as the label.
**Failed because:** live UCSD department options carry irregular internal whitespace. `"000412 - Housing/Dining/Hospitality"` and `"000414 - Bookstore"` (single space after the code dash) selected fine, but `"000719 -  Supply Chain Services"` has a **DOUBLE space** after the dash. `selectOption({ label })` matches the option's *normalized* label exactly, so the raw double-spaced `allTextContents()` string never matched, the select sat waiting, and the step failed with `locator timeout 5000ms` → the run died at `ucpath-job-summary` with the opaque `Timed out waiting for element`. 5 of 23 docs in the 2026-06-22 live separations batch failed this way — every one was a Supply Chain Services separation; the single-space depts all passed. The matching itself worked (the substring `.includes()` already tolerated the double space); only the label-based *selection* was fragile.
**Fix:** select by **index**. New pure helper `pickDepartmentOptionIndex(options, department)` (whitespace-collapsed, case-insensitive substring, skips the `"- - -"` placeholder, returns -1 on no match); `fillFinalTransactions` now calls `deptCombo.selectOption({ index: matchIdx })`. Index sidesteps all label/whitespace matching. Pinned by `tests/unit/systems/kuali/pick-department-option-index.test.ts` (double-space match, case/whitespace-insensitive needle, placeholder skip, first-match wins, -1 on miss/empty). Same whitespace-quirk family as the 2026-06-16 extracted-value lesson above, but on the OUTPUT/select side — when matching a `<select>` option for a fill, prefer `{ index }` (or `{ value }`) over `{ label }` built from scraped text.
**Selector:** `finalTransactions.department` in `selectors.ts` (consumed by `fillFinalTransactions` in `navigate.ts`)
**Tags:** select, selectOption, option, label, index, whitespace, department, final-transactions, separation, kuali

- **2026-06-24: Department dropdown match must be bidirectional — UCPath descriptions carry a division prefix the Kuali label lacks.** `pickDepartmentOptionIndex` only matched when the UCPath dept description was a SUBSTRING of a Kuali option, so UCPath "VCSA-CL ASSOCIATED STUDENTS" / "VCSA CAMPUS RECREATION" never matched Kuali "… Associated Students" / "… Campus Recreation" → "No matching department found" → department left blank. Fix: added a tier 2 — the option NAME (after the "CODE - " prefix) as a substring of the UCPath description — guarded to "specific" names (≥2 words or ≥8 chars) and picking the LONGEST match so a short generic word can't mis-match. Tier 1 (desc ⊆ option) still wins first; no confident match still returns -1 (blank for manual entry — never a guess). Pinned by `tests/unit/systems/kuali/pick-department-option-index.test.ts`. **NEEDS LIVE VERIFY:** confirm the actual Kuali option names for these VCSA departments contain the UCPath name tokens.
