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

## 2026-06-16 — Kuali form inputs return whitespace-padded values

**Tried:** Returning each extracted field from `extractSeparationData` (`navigate.ts`) raw, straight from `.inputValue()` / the `.evaluate()` combobox read, then passing `eid` into UCPath person search and `SeparationDataSchema`.
**Failed because:** Kuali form inputs come back whitespace-padded. The live read-only test (`tests/live/separations-collect.test.ts`, doc #4241) extracted an EID of `" 10772489"` (leading space) and a Location of `"Catering "` (trailing space) — correct digits/text, but the stray whitespace fails `SeparationDataSchema`'s `eid: ^\d{5,}$` and could break the vol/invol exact-match on `terminationType` (`INVOLUNTARY_TYPES.includes(...)`). This is a latent PRODUCTION bug, not just test strictness.
**Fix:** `.trim()` every extracted string field in `extractSeparationData` before returning the `KualiSeparationData` (`employeeName`, `eid`, `lastDayWorked`, `separationDate`, `terminationType`, `location`). For `terminationType` the in-page `.evaluate()` stays simple — trim the returned string in TS. This is normalization of the SAME value, not a cross-source correction: do NOT add a Workforce/name-search fallback to "fix" a wrong EID — a wrong Kuali EID must still fail loudly (see separations workflow CLAUDE.md "Wrong Kuali EID should fail loudly").
**Tags:** extract, eid, whitespace, trim, inputValue, schema, separation, kuali
