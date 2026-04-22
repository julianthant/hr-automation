# i9 — Selector Lessons

Append-only record of selector mistakes and their fixes. Future Claude sessions should read this BEFORE re-mapping a selector. New entries go at the bottom.

Each entry has the same shape so `npm run selector:search` can index it. Required fields: **Tried**, **Failed because**, **Fix**, **Tags**. Optional: **Selector** (if there's a registry entry), **References**.

---

## 2026-04-16 — Search SSN before creating an I-9 profile

**Tried:** Calling `createI9Employee` directly with the candidate's SSN.
**Failed because:** I-9 Complete refuses to create a profile when an existing one already matches the SSN — the workflow blew up at the Save step with a generic dialog.
**Fix:** Always search by SSN first via `searchI9Employee({ ssn })`. If a row comes back, short-circuit to the existing `profileId` instead of creating. Only when search returns empty, proceed to the create path.
**Selector:** `search.ssnInput`, `search.submitButton`, `search.resultRows` in `selectors.ts`
**Tags:** ssn, search, create, profile, duplicate, idempotency

## 2026-04-16 — Datepicker overlay covers the Worksite dropdown after DOB fill

**Tried:** Pressing `Escape` to close the date overlay, then clicking the Worksite listbox.
**Failed because:** I-9 Complete's date picker overlay is rendered as a sibling element with z-index higher than the dropdown — `Escape` does not dismiss it. Click attempts on the listbox land on the overlay instead.
**Fix:** Force-hide the overlay via `document.querySelector('.datepicker-overlay')?.style.setProperty('display', 'none', 'important')` (page.evaluate). Then the Worksite click lands on the actual listbox.
**Selector:** `profile.dob`, `profile.worksiteListbox` in `selectors.ts`
**Tags:** datepicker, overlay, dismiss, worksite, dropdown, dob, click

## 2026-04-16 — Duplicate Employee dialog blocks Save & Continue

**Tried:** Clicking Save & Continue and waiting for the post-save URL.
**Failed because:** When I-9 detects a duplicate (matching SSN, name, or DOB), a Duplicate Employee Record dialog appears with a grid of candidate matches and no automatic dismissal.
**Fix:** Detect the dialog via `profile.duplicateDialog`, select the first row via `profile.duplicateFirstRow`, click `profile.viewEditSelectedButton`, then navigate to `<profileUrl>?saveAndContinue=true` to reveal the radio section that the create flow expects.
**Selector:** `profile.duplicateDialog`, `profile.duplicateFirstRow`, `profile.viewEditSelectedButton` in `selectors.ts`
**Tags:** duplicate, dialog, employee, view, edit, save, continue

## 2026-04-16 — `profileId` extraction races the post-save redirect

**Tried:** Reading the URL immediately after clicking Save & Continue to extract `profileId` from `/employee/profile/{id}`.
**Failed because:** I-9 Complete's post-save redirect is asynchronous; reading the URL too early returns the create-form URL or a transient interstitial.
**Fix:** `await page.waitForURL(/\/employee\/profile\/\d+/)` (or equivalent) before extracting the `profileId` segment. The kernel `ctx.retry` wrapper is sufficient if the wait is included inside it.
**Tags:** profileId, url, redirect, race, save, wait

## 2026-04-22 — Section 2 signer from the Summary audit trail (not the Section 2 tab)

**Tried:** First pass considered opening the Section 2 form tab and reading the signature block, which changes layout depending on whether Section 2 was completed inline vs. via a remote agent.
**Failed because:** The Section 2 tab's DOM shape varies by completion path, and paper-imported I-9s don't expose it at all — it's an unreliable anchor across the four record flavors we care about.
**Fix:** Navigate to `/form-I9/summary/{profileId}/{i9Id}?isRemoteAccess=False` and read the "Electronic I-9 Audit Trail" grid. The row whose accessible name matches `/Signed Section 2/` is uniformly present on every modern signed I-9, and its 4th cell (`Created By`) is the signer's display name. Historical (paper) records get redirected to `/form-I9-historical/{profileId}/{i9Id}/0` and legitimately lack this row — detect via `page.url().includes("/form-I9-historical/")` and report `status: "historical"` rather than conflating with unsigned. Always anchor the wait on the stable "I-9 Record Summary Information" heading (present on both URL shapes) before reading. Use `.first()` on the audit row so amended records with multiple Section 2 signings return the most recent.
**Selector:** `summary.heading`, `summary.signedSection2Row` in `selectors.ts`; consumed from `signer.ts::lookupSection2Signer`.
**References:** Mapped live against profile 2082422 on 2026-04-22 via Playwright CLI.
**Tags:** summary, audit-trail, signer, section2, historical, unsigned, signed, row, createdby
