# kuali — Selector Lessons

Append-only record of selector mistakes and their fixes. Future Claude sessions should read this BEFORE re-mapping a selector. New entries go at the bottom.

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
