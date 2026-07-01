# i9 — Selector Lessons

Structured record of selector mistakes and their fixes. Future Claude sessions should read this BEFORE re-mapping a selector. Before adding an entry, search for related guidance and update/merge stale or contradictory lessons; add a new bottom entry only for a genuinely new failure mode.

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
**Fix:** Navigate to `/form-I9/summary/{profileId}/{i9Id}` and read the "Electronic I-9 Audit Trail" grid. The row whose accessible name matches `/Signed Section 2/` is uniformly present on every modern signed I-9, and its 4th cell (`Created By`) is the signer's display name. Historical (paper) records get redirected to `/form-I9-historical/{profileId}/{i9Id}/0` and legitimately lack this row — detect via `page.url().includes("/form-I9-historical/")` and report `status: "historical"` rather than conflating with unsigned. Always anchor the wait on the stable "I-9 Record Summary Information" heading (present on both URL shapes) before reading. Use `.first()` on the audit row so amended records with multiple Section 2 signings return the most recent.
**Selector:** `summary.heading`, `summary.signedSection2Row` in `selectors.ts`; consumed from `signer.ts::lookupSection2Signer`.
**References:** Mapped live against profile 2082422 on 2026-04-22 via Playwright CLI.
**Tags:** summary, audit-trail, signer, section2, historical, unsigned, signed, row, createdby

## 2026-06-06 — Signer "not found" was a fragile click-through, not extraction; plus access-restricted detection

**Tried:** `lookupSection2Signer` reached the summary by CLICKING through the search result: `openI9SearchResult` clicked the row's last-name link (falling back to the first link), then `ensureSelectedRecordExpanded` broad-scanned the whole DOM (`button,a,div,span`) for an element matching name+createdOn+"next action: X" and clicked it, then `openSummaryTab` clicked a "Summary" tab. Provenzano (Vincent R, profile 1670462 / i9 1602018) reported `Authorized Official Signer — not found` even though "KENIA QUINONEZ" signed Section 2.

**Failed because:** Mapped live 2026-06-06 — the search-result last-name cells are hrefless `<a>` (NOT a link role, so `getByRole("link", {name:/^Provenzano$/})` matched 0; only the "Next Action" cell, e.g. "Purge", is a real link), the broad-scan expand step can click the wrong element, and the Summary-tab re-click races the audit-table load. The EXTRACTION was always correct: the summary page renders a proper `TR→TBODY→TABLE` whose row accessible name contains "Signed Section 2" and whose `<td>` cells are exactly `["2", "<date>", "Signed Section 2", "KENIA QUINONEZ"]` — `getByRole("row",{name:/Signed Section 2/})` + the last cell give the signer. The fragile navigation, not the read, produced the spurious "not found".

**Fix:** Navigate DETERMINISTICALLY — `page.goto(new URL('/form-I9/summary/{profileId}/{i9Id}', page.url()))` using the IDs already on the search hit (the "Purge"/next-action link's href is just this `navToNextAction` route). Detect the paper redirect via `page.url().includes("/form-I9-historical/")` → `historical`. Then wait on the new `summary.auditTrailHeaderRow` ("Section / Date / Audit History Event / Created By") so the audit table has POPULATED before `signedSection2Row.count()` (the heading renders first; counting too early read 0 → mis-classified signed as unsigned). `extractSignedSection2Signer` now reads the LAST cell (Created By), robust to a future leading icon column. Deleted `ensureSelectedRecordExpanded` + `openSummaryTab`. Also added access-restricted detection: a zero-result search whose dialog shows `search.accessRestrictedAlert` ("…your user account has not been granted access to view those employees…", seen live for Goiset, Nadia) now returns `status: "unable-to-access"` (distinct from genuine `not-found`) — the verify completeness report renders "Unable to access" instead of "— not found".

**Selector:** `summary.auditTrailHeaderRow`, `summary.signedSection2Row`, `search.accessRestrictedAlert` in `selectors.ts`; consumed from `signer.ts::lookupSection2Signer`.
**References:** Mapped live 2026-06-06 via Playwright CLI against profile 1670462 / i9 1602018 (Provenzano, signer present) and the Goiset, Nadia access-restricted search. Supersedes the click-through navigation in the 2026-04-22 entry; the summary-URL + audit-trail read itself is unchanged.
**Tags:** summary, audit-trail, signer, section2, navigation, not-found, unable-to-access, access-restricted, row, createdby

## 2026-07-01 — I-9 login migrated to the UCOP portal (UCSD SSO + Duo); standalone vendor login retired

**Tried:** The pre-2026-07-01 `loginToI9` authenticated directly against the I-9 Complete vendor (`stse.i9complete.com`) with a standalone email/password (`validateI9Env` → `I9_USER_ID`/`I9_PASSWORD`, falling back to UCPath), detecting success via the `stse.→wwwe.i9complete.com` host change and classifying a credential rejection (`/Account/Login` bounce) via the pure `classifyI9LoginResult` helper + `login.loginError` selector. This whole model is now gone.

**Failed because:** The operator switched the entry point to the **UCOP portal** (`https://i9complete.ucop.edu`), which does **not** accept a direct vendor password — the landing page's only path is "Tracker I-9 Complete Application", a SAML link to `samlproxy.ucop.edu` that mandates **campus SSO** ("log in with your campus SSO credentials"). So the direct-login form, the `stse.` host, the separate `I9_PASSWORD`, the `/Account/Login` bounce, and `classifyI9LoginResult` no longer exist in the flow — they were all removed. Mapped + verified live 2026-07-01: landing → click launch link → `samlproxy.ucop.edu` WAYF (`<select id="dropdownlist">`, pick "University of California, San Diego", click **Select**) → UCSD TritON SSO (`a5.ucsd.edu`, `#ssousername`/`#ssopassword`, `button[name="_eventId_proceed"]`) → **Duo** → landed on `wwwe.i9complete.com` (same app + same "Dismiss the Notification" training popup as before).

**Fix:** `loginToI9` now drives the UCOP landing + SAML WAYF hops (new `login.appLaunchLink` / `login.idpSelect` / `login.idpSelectButton` selectors) then joins the **shared UCSD SSO path** — `fillSsoCredentials` → `clickSsoSubmit` → `pollDuoApproval`/`requestDuoApproval` — with `successUrlMatch: url.includes("i9complete.com") && !duosecurity`. It reuses **UCPath credentials** (via `fillSsoCredentials`→`validateEnv`), so hands-off Duo WebAuthn covers it like every other UCSD system, and it accepts `(instance, abortSignal)` to join the global Duo queue for multi-system launches (onboarding = UCPath + I-9). `I9_URL` → `https://i9complete.ucop.edu`; a new stable `I9_APP_URL` (`https://wwwe.i9complete.com`) backs deep-links (`create.ts` `saveAndContinue`) that the old `.replace("stse.","wwwe.")` derivation used to build. A bad SSO credential now fails on the `a5.ucsd.edu` form → `pollDuoApproval` false → `requireLogin` throws (same path as all other SSO systems), so no i9-specific classifier is needed. `validateI9Env`, `I9_USER_ID`/`I9_PASSWORD`, `classifyI9LoginResult`, `login.loginError`, and the old direct-login selectors (`usernameInput`/`nextButton`/`passwordInput`/`loginButton`) were all deleted.

**Selector:** `login.appLaunchLink`, `login.idpSelect`, `login.idpSelectButton` in `selectors.ts`; SSO form + Duo are the shared `src/infra/auth/sso-fields.ts` / `duo-poll.ts` selectors.
**References:** Mapped + verified end-to-end live 2026-07-01 via `playwright-cli` + Duo Autopilot (landed on `wwwe.i9complete.com` Required Training Notification, logged in). Supersedes the retired 2026-06-04 "I-9 credentials can differ from UCPath" and 2026-06-24 "waitForURL(wwwe) masked a stale password" entries — both described the now-deleted vendor login.
**Tags:** i9, login, sso, shibboleth, duo, ucop, samlproxy, wayf, triton, credentials, migration
