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

## The Employee Lookup keyset (load-bearing)

Selecting **Document Types** + **File Type**, then typing the **UCPath ID** and
**Tab**, fires the `Employee Lookup` keyset which **autofills every keyword** —
Last/First Name, Department Name + Code, Vice Chancellor (`VC-CHIEF FINANCIAL
OFFICER`) + Code (`VCCFO`), titles, hire dates, status. The **only** required
("red") field it does NOT fill is **Document Name** (set the per-doc-type
constant; Emergency Contact = `EMERGENCY CONTACT INFORMATION`).

So the happy-path import is: doc type → File Type `PDF (.pdf)` → keyset
`Employee Lookup` → attach file → UCPath ID + Tab → set Document Name → verify
the reds are filled → Import. `enterUcpathIdAndTab` returns whether the keyset
populated; if it returns false (bad/unknown UCPath ID), the caller fills the
required keywords from OCR / person-lookup fallback data before Import.

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
- Never click **Import** in a dry run — it commits a real document.

## Lessons Learned

See [`LESSONS.md`](./LESSONS.md).
