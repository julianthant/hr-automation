# OnBase — Selector Lessons

Structured lessons for OnBase selector + navigation failures. Search here
before mapping a new selector; merge stale entries rather than duplicating.

## 2026-07-17 — The Select Employee click in the Employee Lookup modal can be SWALLOWED mid-postback — confirm the dialog actually closes, re-click while it doesn't

**Tried:** Treating the "Select Employee" click as fire-and-forget in
`lookupEmployeeViaKeyset`: poll `selectEmployeeButton.isEnabled()` → `safeClick`
→ immediately poll the import form's `Last Name` for the keyset autofill, never
looking at the dialog again.
**Failed because:** The click can land while the results grid's async postback
is still re-rendering (the button enables ~1.3s after Find), and OnBase's
WebForms page swallows it — the click is dispatched successfully (logged
`clicked in 17ms`) but the selection postback never fires. Captured live
2026-07-17 (UCPath ID 10848084): the kernel's step-failure screenshot showed the
Employee Lookup dialog STILL OPEN 8s+ after the click was logged, result row
found and highlighted, keywords blank — so the 8s `Last Name` settle window
expired and the run terminal-failed with "keywords did not populate" even though
the employee existed and was matched. The dialog also stayed open across the
throw, polluting the page the operator's Retry replays onto.
**Fix:** The dialog CLOSING is the observable proof the selection postback
fired. `lookupEmployeeViaKeyset` now clicks Select Employee, waits up to 4s for
`keysetLookup.dialog` to reach `state:"hidden"`, and re-clicks the same button
(bounded, `SELECT_EMPLOYEE_CLICK_ATTEMPTS = 3` — retrying the SAME operation on
a transient, not a fallback) while the dialog is still open. If it never closes,
close it (`closeKeysetDialog`) for a clean retry surface and throw loud
("selection postback did not fire"). Only after the dialog is confirmed closed
does the existing `Last Name` settle poll run. Pinned by
`tests/unit/systems/onbase/keyset-lookup.test.ts` (swallowed-click re-click +
never-closes throw); the race itself is a server-timing event that can't be
summoned live on demand.
**Selector:** `keysetLookup.dialog`, `keysetLookup.selectEmployeeButton`
**References:** the 2026-07-02 keyset-modal entry below (same modal, mechanism
discovery); `.tracker/screenshots/onbase-…-error-fill-keywords-…1784302787491.png`
(the live capture)
**Tags:** onbase, import, keyset, employee-lookup, modal, dialog,
select-employee, swallowed-click, postback, re-render, race, retry, fill-keywords

## 2026-07-02 — The Document Queue (frmViewer iframe): leftover rows duplicate imports, leaving with queued docs fires a native beforeunload confirm, and the Import button enables on attach alone

**Tried:** (1) `chooseFile` = fire-and-forget `setInputFiles` + a log line.
(2) Navigating the top page away from the Import form (the kernel's
between-items `resetUrl` goto, or a recovery re-nav) while a document was still
queued. (3) Treating `isImportEnabled` as proof the form was complete.
**Failed because:** The right-hand "Document Queue (N)" panel lives in the
`frmViewer` iframe (`FileUploadEnhancedRightPage.aspx`) — a top-page SIBLING of
`NavPanelIFrame`, so nothing in the import frame confirms an attach. The queue
is page-scoped (a fresh Import Document load starts empty — verified live
2026-07-02) but it SURVIVES same-page kernel retries: a file attached by a
failed prior attempt stays queued, and the next attempt's Import would file
BOTH documents (a duplicate). Navigating away with anything queued fires a
NATIVE beforeunload confirm — Playwright's default auto-DISMISS cancels the
navigation, so the reset goto times out (captured live 2026-07-02: the
playwright-cli session hit the same modal). And the Import button enables the
moment a document is queued, with every required keyword still blank — so a
single `isEnabled` sample is neither a completeness guard nor reliable (it
commits via an async postback; a read right after the last fill can see a
transient disabled state).
**Fix:** `installOnbaseDialogGuard` (in `openImportDocument`, WeakSet-once per
page) accepts `beforeunload` dialogs and dismisses everything else;
`clearLeftoverQueuedDocuments` removes stale queue rows
(`documentQueue.removeButtons`) before attach and fails loud if the queue won't
empty; `chooseFile` confirms the attach by waiting for the file's row
(`documentQueue.queuedRow`, status "Pending Import") and throws
(kernel-retryable) if it never lands; `waitForImportEnabled` polls out the
transient-disabled window while `readRequiredKeywordValues` stays the true
completeness gate.
**Selector:** `documentQueue.frame`, `documentQueue.queuedRow`,
`documentQueue.removeButtons`, `importForm.fileInput`, `importForm.importButton`
**Tags:** onbase, import, document-queue, beforeunload, dialog, duplicate,
attach, pending-import, frmviewer, import-button, upload, confirm

## 2026-07-02 — Employee Lookup keyset is a MODAL search, NOT inline Tab-autofill (supersedes the 2026-06-22 claim)

**Tried:** Driving the keyset by filling the import form's `UCPath ID` field and
pressing **Tab**, then polling `Last Name` to populate (`enterUcpathIdAndTab`) —
per the original 2026-06-22 note that "typing the UCPath ID + Tab autofills every
keyword."
**Failed because:** That is simply not how the form works (verified live
2026-07-02, headless via `sel:browser`). Filling the main-form UCPath ID + Tab
does **nothing** — `Last Name` stayed empty for 15s under Tab, the key-icon
"Apply", and Enter. So the daemon logged `keyset autofilled=false` and then threw
`required keyword(s) still empty: Department Name, Department Code, Vice
Chancellor, Vice Chancellor Code` — because those fields come ONLY from the
keyset and OCR never provides them, so the "fallback" path can never fill them.
The keyset is actually a **modal search**: the key-icon beside "Keyset Lookup"
(`importForm.keysetApplyButton`) opens a top-page `dialog "Employee Lookup"`
whose search form is in a nested `ReverseKeysetLookup.aspx` iframe. You fill the
modal's OWN UCPath ID, click **Find**, the matching row auto-selects so **Select
Employee** enables, and clicking it closes the dialog and autofills every keyword
(Last/First Name, Department + code, Vice Chancellor `VCFA`/`VCCFO` + code, …).
A miss shows "No matching records were found" — which is a *data* problem (bad /
mis-OCR'd UCPath ID), NOT a mechanism failure, and is unrecoverable for import.
**Fix:** `lookupEmployeeViaKeyset(page, ucpathId)` drives the modal: open →
fill modal UCPath ID → Find → wait for Select-Employee-enabled (match) or the
no-match message → click Select Employee → confirm `Last Name` populated. Only
**Document Name** is still set manually (`EMERGENCY CONTACT INFORMATION`). A false
return is terminal for import (surface "not found in Employee Lookup", don't
pretend fallback can fill Dept/VC). The old `enterUcpathIdAndTab` +
its Tab/inline-autofill assumption are removed.
**Selector:** `keysetLookup.dialog`, `keysetLookup.frame`,
`keysetLookup.ucpathIdInput`, `keysetLookup.findButton`,
`keysetLookup.selectEmployeeButton`, `keysetLookup.noMatchMessage`,
`importForm.keysetApplyButton`
**Tags:** onbase, import, keyset, employee-lookup, modal, dialog, iframe, find, select-employee, ucpath-id, no-match, autofill

## 2026-06-22 — Import form lives in iframe[name="NavPanelIFrame"]

**Tried:** Locating the import keyword fields on the top `NavPanel.aspx` page.
**Failed because:** `NavPanel.aspx` nests iframes; the Import Document form is
rendered inside `iframe[name="NavPanelIFrame"]` (src `FileUploadEnhanced.aspx`).
Top-page locators never match the form fields, and the inline-selector guard
forbids `.frameLocator(` outside `selectors.ts`.
**Fix:** Resolve the FrameLocator once in the registry
(`importForm.frame(page)`) and have every field selector take a `FrameLocator`.
The nine-squares Main Menu and its menu items stay on the top `Page`.
**Selector:** `importForm.frame`, `nav.mainMenuButton`
**Tags:** onbase, iframe, frame, navpanel, import, main-menu

## 2026-07-01 — Login.aspx is still hylandcloud.com — never treat the hostname as authenticated

**Tried:** Short-circuiting OnBase auth when `page.url()` includes
`hylandcloud.com` after `goto(NavPanel.aspx)`.
**Failed because:** An expired session lands on
`https://ucsd.hylandcloud.com/251ids/Login.aspx`, which matches the hostname
check. The authenticate step logged "already authenticated" in ~200ms, then
`prepare-import` redirected to Login.aspx and timed out waiting for Main Menu.
**Fix:** Probe the real session — `Login.aspx` → not authenticated; otherwise
wait for the nine-squares `nav.mainMenuButton` on NavPanel. After Duo, verify
Main Menu visibility (same pattern as ServiceNow's post-auth form check). Also
let the SAML redirect chain settle (`networkidle`) before probing — `domcontentloaded`
fires on the intermediate hylandcloud hop before SSO redirect completes.
**Selector:** `nav.mainMenuButton`
**Tags:** onbase, auth, login, sso, login.aspx, session, false-positive

## 2026-07-02 — OnBase allows ONE app session per identity: a PERSISTENT NavPanel 403 + the abort-only "Another session is currently active" dialog are the same failure; recover via Logout.aspx (extends the 2026-07-01 transient-403 entry)

**Tried:** (1) Treating every NavPanel `403 - Forbidden` as the transient
affinity-loss landing and recovering with plain reloads (the 2026-07-01
approach below). (2) When the daemon held an OnBase login, running a second
session (function-level live runs) with the same account — every login attempt
then failed all evening: 15 `OnBase authentication failed` / 11 `SSO form did
not render (URL: …/NavPanel.aspx)` in one day's daemon log.
**Failed because:** OnBase (the `251ids` Hyland identity server) enforces a
**single app session per identity**. While a session is held — including by a
CRASHED or killed browser whose server-side session hasn't timed out — a new
login cannot proceed: `Login.aspx` renders a "User Interaction Required" dialog
whose nested EmbeddedPage iframe says **"Another session is currently
active."** with exactly ONE radio option ("Close this session and continue
using the active session.") that ABORTS the new login (→ Close.aspx, "safe to
close this window"); there is NO takeover option. Meanwhile direct
`NavPanel.aspx` GETs serve a **persistent** IIS `403 - Forbidden` (not the
transient one) — reloads never clear it, so the reload-only recovery burned its
attempts and the auth failed. The contention marker is invisible to
`page.content()` (it lives in a child iframe), so the old flow saw only "SSO
form did not render".
**Fix:** `Logout.aspx` terminates the stale app session using the browser's
identity-server cookie, and re-entering via `Login.aspx` rides the still-valid
IdP session straight back to an authenticated NavPanel (no SSO, no Duo —
captured live 2026-07-02); with no IdP session it just falls to the normal SSO
form. `page-state.ts` adds `session-contention` (`isOnbaseSessionContention`
sweeps `page.frames()` content; classify ranks it ABOVE the bare `Login.aspx`
URL since the dialog is served there) and marks it reauth-required.
`login.ts` `clearOnbaseActiveSession` does the Logout→Login hop: pre-SSO when
the landing shows contention, and post-Duo in `buildOnbaseSuccessCheck` (once)
when contention appears or a 403 persists after both reloads.
`waitForOnbaseAuthLanding` no longer returns on the bare `Login.aspx` URL — it
is a ROUTER page ("Please Wait…") that resolves to SSO or the contention dialog
a beat later. Idempotent: Logout.aspx with no active session is a harmless
"Session Ended" no-op. Verified live 2026-07-02 (fresh profile blocked by a
stale daemon session → Logout.aspx → Login.aspx → authenticated NavPanel).
**Selector:** `nav.mainMenuButton`
**References:** the 2026-07-01 transient-403 entry below (plain reloads still
handle the affinity-loss case); `tests/unit/infra/auth/onbase-login.test.ts`
(pre-SSO + post-Duo contention recovery pins)
**Tags:** onbase, auth, session, single-session, contention, another-session,
logout, login-aspx, 403, forbidden, persistent, hyland, identity-server, recovery

## 2026-07-01 — NavPanel.aspx can serve an IIS 403 at the normal URL until reloaded

**Tried:** Detecting OnBase `403 - Forbidden` by checking whether
`page.url()` contained `403` or `Forbidden`, then letting the post-Duo success
check keep polling for `nav.mainMenuButton`.

**Failed because:** The failing IIS page keeps the normal
`https://ucsd.hylandcloud.com/251ids/NavPanel.aspx` URL; only the HTTP status
on direct navigation and the page title/body say `403 - Forbidden: Access is
denied.` After Duo, `successUrlMatch` saw `hylandcloud.com`, but
`successCheck` only looked for the Main Menu, so it waited until timeout unless
the operator manually reloaded the tab.

**Fix:** Treat a `403` response status or a page title matching
`403 - Forbidden` / `Access is denied` as the forbidden landing state. During
the OnBase Duo success check, reload `NavPanel.aspx` from that state and
re-probe `nav.mainMenuButton`; also use the same status/title detection before
falling back to `Login.aspx` on the initial OnBase navigation. **A 403 that
plain reloads do NOT clear is the single-session contention case — see the
2026-07-02 entry above (Logout.aspx recovery).**

**Selector:** `nav.mainMenuButton`
**Tags:** onbase, auth, sso, navpanel, 403, forbidden, reload, hyland, main-menu

## 2026-07-01 — "Validation of viewstate MAC failed" is session fragility, not bot protection — classify the NavPanel landing and recover

**Tried:** Treating a full-page OnBase error reading "Validation of viewstate
MAC failed … Web Farm or cluster … machineKey" as anti-automation / bot
protection to work around. Separately, `openImportDocument`/`loginToOnBase` just
waited for the nine-squares Main Menu (or the SSO form) until timeout whenever
NavPanel didn't render the app.

**Failed because:** It is a raw ASP.NET WebForms error — a postback whose
`__VIEWSTATE` was signed on one node of the load-balanced `ucsd.hylandcloud.com`
cluster is validated by another node after session-affinity loss (the machineKey
differs). NOT bot protection (that would be a CAPTCHA/403 challenge, not a
framework stack diagnostic). It is one of a FAMILY of transient bad-landing
states NavPanel.aspx serves at the normal URL — alongside the 403 above, the
"It is safe to close this window" logout page, `Login.aspx` session-expiry, and
the form reset back to Document Retrieval. The old flow only detected 403 +
`Login.aspx`, so the rest blind-timed-out as `mainMenuButton` click timeout
(`prepare-import`) or "SSO form did not render" (`authenticate`). Worse, the
`import` step ran `clickImport` → `waitForLoadState('networkidle').catch(()=>{})`
→ unconditionally stamped `status:"Imported"` — a **silent false success** if the
Import postback returned the ViewState error page (document never filed).

**Fix:** New `src/systems/onbase/page-state.ts` — `classifyOnbasePage(page)` →
`authenticated | viewstate-error | session-closed | forbidden | login | unknown`
by reading `page.title()` + `page.content()` (guard-safe: NOT locator
constructors, so the inline-selector guard is happy) plus the Main Menu probe.
`ensureNavPanelReady`/`openImportDocument` now classify-and-recover: a fresh
NavPanel **GET** (rebuilds ViewState on the current node) for
`viewstate-error`/`forbidden`/`unknown`, up to 3 attempts; a thrown
`OnbasePageStateError` for `session-closed`/`login` so the kernel retry
re-authenticates. `login.ts` `waitForOnbaseAuthLanding` + `buildOnbaseSuccessCheck`
recognize and reload the ViewState error the same way as the 403. The `import`
step asserts the post-import page is not a recognized error state before
reporting "Imported". Pinned by `tests/unit/systems/onbase/{page-state,navigate}.test.ts`
+ the ViewState case in `tests/unit/infra/auth/onbase-login.test.ts`; happy path
verified live end-to-end by `tests/live/onbase-import.test.ts` (hands-off Duo →
authenticated → Import Document form rendered). The intermittent recovery branch
can't be summoned live (server-side affinity event) — it's covered
deterministically by the unit tests.

**Selector:** `nav.mainMenuButton`
**References:** `src/systems/onbase/LESSONS.md#2026-07-01` (the 403 lesson — same
bad-landing family, recovered the same way)
**Tags:** onbase, viewstate, mac, hyland, hylandcloud, asp-net, session, navpanel, import, recovery, false-success, auth, main-menu

## 2026-07-01 — OnBase Duo defaults to security key — do not abort the auto-fire grace early

**Tried:** Treating the "Use your security key" screen as an immediate signal to
bail out of Phase 1 and jump to the click path (Escape → Other options).
**Failed because:** OnBase (Hyland) auto-fires a discoverable security-key
ceremony on prompt load. Bailing the instant the screen appeared cancelled the
in-flight ceremony before the pre-armed `usb` virtual authenticator could answer
it, leaving the operator stuck on Chrome's native "insert your security key"
dialog with no phone push. The manual fallback also failed because the native
dialog blocked clicks on "Other options".
**Fix:** Keep polling `hasSigned` for the full Phase 1 grace window even when
the security-key screen is visible (same as Touch ID auto-fire for UCPath).
`triggerDuoPushFromFactorScreen` now presses Escape before clicking Other
options → Duo Push when WebAuthn fallback is needed. Requires hands-off Duo
(`HR_AUTOMATION_DUO_WEBAUTHN=1`, default when running `npm run dashboard`) and
enrolled credentials in `.auth/duo-webauthn.json`.
**Tags:** onbase, auth, duo, security-key, webauthn, hands-off, hyland

## 2026-06-22 — Duo security-key screen blocks page clicks during manual mapping

**Tried:** Mapping OnBase via `playwright-cli`: after SSO submit, Duo landed on
"Use your security key" and clicking "Other options" to switch to Duo Push did
nothing.
**Failed because:** The security-key screen auto-fires a WebAuthn `get()` that
opens a native Chrome dialog, which blocks all page-level clicks until
dismissed — the same behavior the production hands-off WebAuthn path handles
with an armed virtual authenticator.
**Fix:** For manual mapping, run **headed** (`--headed`) and approve Duo in the
visible window (security key tap, or Escape → Other options → Duo Push on the
phone). Production daemon auth is unaffected — `HR_AUTOMATION_DUO_WEBAUTHN=1`
arms the authenticator at `clickSsoSubmit` and approves hands-off.
**Tags:** onbase, auth, duo, security-key, webauthn, playwright-cli, mapping
