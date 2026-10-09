# OnBase Module

OnBase (Hyland) document management automation: drives the **Import Document**
screen to file HR documents (Emergency Contact first) against the Employee
Lookup keyset. Auth is UCSD Shibboleth SSO + Duo (same path as CRM, reuses
`UCPATH_USER_ID` / `UCPATH_PASSWORD`) — `loginToOnBase` in
`src/infra/auth/login.ts`.

## Page model

`NavPanel.aspx` nests iframes. Two surfaces matter:

- **Top page** — the nine-squares **Main Menu** (`nav.mainMenuButton`) and its
  items (`Import Document`, `Document Retrieval`).
- **Import form iframe** — `iframe[name="NavPanelIFrame"]` (src
  `FileUploadEnhanced.aspx`). All import fields live here; resolve the
  FrameLocator once via `importForm.frame(page)`.

Navigate in via `openImportDocument(page)` (Main Menu → Import Document → wait
for the UCPath ID field).

## The Employee Lookup keyset (load-bearing) — it's a MODAL, not Tab-autofill

The keyset autofills every keyword — Last/First Name, Department Name + Code,
Vice Chancellor (e.g. `VC-FINANCE AND ADMINISTRATION`) + Code (`VCFA`/`VCCFO`),
titles, hire dates, status — but **NOT via typing the UCPath ID + Tab** (that
does nothing; verified live 2026-07-02). It is a **modal search**: the key-icon
beside "Keyset Lookup" (`importForm.keysetApplyButton`) opens a top-page
`dialog "Employee Lookup"` whose search form is in a nested
`ReverseKeysetLookup.aspx` iframe (`keysetLookup.*` selectors). Fill the modal's
UCPath ID → **Find** → the match auto-selects → **Select Employee** closes the
dialog and autofills every keyword. The **only** required ("red") field it does
NOT fill is **Document Name** (set the per-doc-type constant; Emergency Contact =
`EMERGENCY CONTACT INFORMATION`).

So the happy-path import is: doc type → File Type `PDF (.pdf)` → keyset
`Employee Lookup` → attach file → `lookupEmployeeViaKeyset(page, ucpathId)`
(modal: fill → Find → Select Employee) → set Document Name → verify the reds are
filled → Import. `lookupEmployeeViaKeyset` returns whether an employee matched;
if it returns false the UCPath ID had **no OnBase match** (bad/mis-OCR'd ID) —
and since Department/Vice-Chancellor come ONLY from the keyset, OCR fallback
cannot fill them, so import must fail loud with a "not found" message.

`ONBASE_REQUIRED_KEYWORDS` is the red-field list the handler verifies.
`readRequiredKeywordValues(page)` reads their current values; `isImportEnabled`
gates the final click.

## Document types

The Import Document "Document Types" dropdown carries 24 `X_HR_*` types across
two groups (Payroll Records: Benefits, Taxes; Personnel Records: Awards and
Honors … **Emergency Contact** … Work Schedule). Only `X_HR_Emergency Contact`
is wired today (`ONBASE_EC_DOCUMENT_TYPE`).

## Before mapping a new selector

1. `npm run selector:search "<intent>"` — reuse before remapping.
2. Check [`LESSONS.md`](./LESSONS.md) for known failure modes.
3. Map live via `playwright-cli`, add the selector to
   [`selectors.ts`](./selectors.ts) with JSDoc + `@tags` + `// verified
   YYYY-MM-DD`, then `npm run selectors:catalog`.
4. Confirm `npx vitest run tests/unit/systems/inline-selectors.test.ts`.

See [`SELECTORS.md`](./SELECTORS.md) for the generated catalog and
[`common-intents.txt`](./common-intents.txt) for typical intents.

## Gotchas

- The whole form is inside `iframe[name="NavPanelIFrame"]`; field selectors take
  a `FrameLocator`, the Main Menu selectors take the top `Page`.
- `Document Types` / `File Type` / `Keyset Lookup` are real `<select>` elements
  — drive with `.selectOption({ label })`, not `.fill()`. The keyword fields are
  textboxes, except Department / Vice Chancellor which are dataset comboboxes.
- The form occasionally resets back to Document Retrieval if interactions race;
  `openImportDocument` re-navigates and waits for the UCPath ID field.
- NavPanel.aspx intermittently serves a transient bad page at the normal URL
  instead of the app — a **ViewState-MAC error** ("Validation of viewstate MAC
  failed"; the hylandcloud cluster is ASP.NET WebForms, so this is farm-affinity
  loss, **not** bot protection), a 403, the "safe to close this window" logout,
  a `Login.aspx` redirect, or the Document-Retrieval reset. `page-state.ts`
  (`classifyOnbasePage`) recognizes these; `ensureNavPanelReady` re-navigates
  fresh (with backoff) to recover the transient ones and throws
  `OnbasePageStateError` on session death (→ kernel retry re-auths). The
  `import` step asserts the post-import page is not an error page before
  reporting success. See [`LESSONS.md`](./LESSONS.md) (2026-07-01 ViewState-MAC
  entry).
- **OnBase allows ONE app session per identity.** A stale session (e.g. a
  crashed daemon browser) makes every new login fail: Login.aspx shows the
  abort-only "Another session is currently active." dialog (in a nested iframe —
  invisible to `page.content()`) and NavPanel GETs serve a **persistent** 403.
  `classifyOnbasePage` → `session-contention`; the login flow recovers via
  `Logout.aspx` → `Login.aspx` (`clearOnbaseActiveSession`), which terminates
  the stale session and rides the IdP session back in. Do NOT run two OnBase
  logins concurrently (daemon + live test) — the second steals the slot. See
  [`LESSONS.md`](./LESSONS.md) (2026-07-02 single-session entry).
- The right-hand **Document Queue** (`frmViewer` iframe, a top-page SIBLING of
  `NavPanelIFrame`) is the attach confirmation ("Pending Import" row). Leftover
  rows from a failed same-page attempt would import as DUPLICATES —
  `openImportDocument` clears them; `chooseFile` waits for the queued row.
  Leaving the form with anything queued fires a native **beforeunload** confirm
  (`installOnbaseDialogGuard` accepts it or the kernel reset nav stalls). The
  **Import button enables on attach alone** (keywords blank!) — it is not a
  completeness guard; `readRequiredKeywordValues` is. See
  [`LESSONS.md`](./LESSONS.md) (2026-07-02 Document Queue entry).
- Never click **Import** in a dry run — it commits a real document.

## Lessons Learned

See [`LESSONS.md`](./LESSONS.md).
