# OnBase — Selector Lessons

Structured lessons for OnBase selector + navigation failures. Search here
before mapping a new selector; merge stale entries rather than duplicating.

## 2026-06-22 — Employee Lookup keyset autofills every keyword except Document Name

**Tried:** Planning to extract every import keyword (names, department, vice
chancellor) from OCR and fill them all into the OnBase import form.
**Failed because:** It is unnecessary work and a fragile path — OnBase's
`Employee Lookup` keyset autofills Last/First Name, Department Name + Code,
Vice Chancellor (`VC-CHIEF FINANCIAL OFFICER`) + Code (`VCCFO`), titles, hire
dates and status the instant you type the `UCPath ID` and press **Tab**. The
ONLY required ("red") field it leaves blank is **Document Name**.
**Fix:** Drive the happy path off the keyset — type UCPath ID + Tab, wait for
Last Name to populate (`enterUcpathIdAndTab` polls for this and returns a
boolean), then set Document Name = `EMERGENCY CONTACT INFORMATION`. OCR only
needs the UCPath ID; the rest of the keyword data is fallback for when the
keyset returns nothing (bad/unknown ID).
**Selector:** `importForm.ucpathIdInput`, `importForm.documentNameInput`
**Tags:** onbase, import, keyset, employee-lookup, autofill, ucpath-id, document-name

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
