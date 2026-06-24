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
**Fix:** Navigate to `/form-I9/summary/{profileId}/{i9Id}?isRemoteAccess=False` and read the "Electronic I-9 Audit Trail" grid. The row whose accessible name matches `/Signed Section 2/` is uniformly present on every modern signed I-9, and its 4th cell (`Created By`) is the signer's display name. Historical (paper) records get redirected to `/form-I9-historical/{profileId}/{i9Id}/0` and legitimately lack this row — detect via `page.url().includes("/form-I9-historical/")` and report `status: "historical"` rather than conflating with unsigned. Always anchor the wait on the stable "I-9 Record Summary Information" heading (present on both URL shapes) before reading. Use `.first()` on the audit row so amended records with multiple Section 2 signings return the most recent.
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

## 2026-06-04 — I-9 credentials can differ from UCPath credentials

**Tried:** Reusing `validateEnv()` inside `loginToI9`, which always pulls `UCPATH_USER_ID` and `UCPATH_PASSWORD`, then relying on OCR verify's delegated `i9-lookup` rows to authenticate with I-9 Complete.

**Failed because:** Tracker I-9 / I9 Complete can have a separate password from UCPath. When the I-9-specific credential differs, the daemon starts under the wrong password source and delegated signer lookups fail or get cancelled before lookup.

**Fix:** Use `validateI9Env()` for `loginToI9`. It reads `I9_USER_ID` and `I9_PASSWORD` when either I-9-specific credential is configured, requires both to avoid mixing credential pairs, and falls back to the UCPath pair only when both I-9 vars are absent. Keep `.env.example` documenting the optional override.

**Tags:** i9, auth, credentials, env, daemon, login, verify, signer

## 2026-06-24 — i9 login `waitForURL(wwwe)` masked a stale password as an opaque nav timeout

**Tried:** `loginToI9` detected success by waiting ONLY for the post-login redirect — `page.waitForURL(url => url.hostname.includes("wwwe.i9complete.com"), { timeout: 15_000 })` — with no branch for a rejected login.

**Failed because:** When the standalone `I9_PASSWORD` in `.env` was stale (i9 Complete passwords rotate independently of UCPath — see the 2026-06-04 entry), the submit was refused and the page bounced back to `https://stse.i9complete.com/Account/Login` showing "The username or password provided was incorrect." The success host never appeared, so `waitForURL` ran out its full 15s on each of 3 auth attempts and surfaced an opaque `page.waitForURL: Timeout 15000ms exceeded` at `login.ts:50` — blaming "navigation" when the real cause was a bad credential. An e2e handoff even hypothesized a `wwwe→stse` domain migration; a live probe disproved it (both hosts resolve to the same server `52.143.80.80`, and the login simply failed with a visible error).

**Fix:** After the Log in click, RACE the success redirect against the credential-rejection error (`login.loginError` = `getByText(/username or password.*(incorrect|invalid)/i)`), then feed `{ url, errorText }` to the pure `classifyI9LoginResult` helper. It throws a loud, actionable error ("I9 Complete rejected the login: …. Check I9_USER_ID / I9_PASSWORD in .env …") on a rejection or a `/Account/Login` bounce, and a precise "did not reach wwwe… still at <url>" on a genuine nav timeout. The `wwwe` success predicate is deliberately UNCHANGED (no blind URL swap) — if a real post-login host migration ever happens, the new timeout message names the actual landing host so the next session sees it immediately. Pure classifier pinned by `tests/unit/systems/i9/login.test.ts`.

**Selector:** `login.loginError` in `selectors.ts`; consumed from `login.ts::loginToI9` / `classifyI9LoginResult`.
**References:** Diagnosed live 2026-06-24 via a throwaway `loginToI9` probe (reused the real selectors + browser launcher, observed the actual post-login URL instead of waiting for `wwwe`). Root data cause is the 2026-06-04 "I-9 credentials can differ from UCPath credentials" entry.
**Tags:** i9, login, waitforurl, timeout, credentials, password, fail-loud, account-login, rejected, classify
