# ServiceNow / UCSD Employee Center

UCSD's HR Employee Center is hosted on ServiceNow at
`support.ucsd.edu/esc`. Authentication is UCSD SSO + Duo (same
TritON SAML IdP as UCPath). This module currently covers ONE form: the
HR General Inquiry catalog item, used by `oath-upload` to file a
ticket after every paper-roster signing ceremony is completed in
UCPath.

## Auth

`loginToServiceNow` in `src/infra/auth/login.ts` mirrors `loginToUCPath`:
fill UCSD SSO username + password, click Log In, poll Duo via
`requestDuoApproval`. The form lives in the main DOM (no iframe), so
no `getContentFrame` adapter is needed.

## Selector Intelligence

This module touches: **servicenow**.

Before mapping a new selector:

```bash
npm run selector:search "<intent>"
```

- [`./LESSONS.md`](./LESSONS.md)
- [`./SELECTORS.md`](./SELECTORS.md)
- [`./common-intents.txt`](./common-intents.txt)

## Gotchas

- **"Specifically:" and "Category:" are Select2 v3 typeaheads**, not
  plain comboboxes. The accessible combobox (`getByRole("combobox",
  …)`) is an OFFSCREEN focusser; the visible `a.select2-choice`
  intercepts clicks, so clicking the focusser times out. Drive them via
  `specificallyChoice` / `categoryChoice` (open the drop) → `select2DropSearch`
  (type) → `select2ResultOption` (pick). `Category` tries native
  `selectOption` first, then this Select2 path. `oath-upload`'s
  `fill-form.ts` encapsulates the pattern and wraps registry-locator
  clicks/fills in `safeClick` / `safeFill` so fallback failures surface
  in the dashboard's selector-health panel. See LESSONS.md (2026-06-02).
- **Choose-a-file button drives a hidden file input.** Use
  `page.setInputFiles` on the adjacent `input[type="file"]` — clicking
  the visible button surfaces an OS file picker that Playwright would
  have to handle via `page.on("filechooser", ...)`. The hidden-input
  path is more reliable.
- **Submit redirects to a ticket detail page.** The redirect URL
  carries `number=HRC0XXXXXX` for the new ticket. Implementation reads
  `page.url()` post-submit and parses it; if the URL shape changes,
  fall back to scraping the ticket-detail page heading.

## Lessons Learned

- **2026-05-15: ServiceNow form interactions need safe wrappers too.** The selectors live in `src/systems/servicenow/selectors.ts`, but oath-upload drives them from workflow code. Keep those workflow calls wrapped with `safeClick` / `safeFill` labels prefixed `servicenow hr inquiry ...`; otherwise ServiceNow is invisible to selector-health aggregation even though it is a system driver surface.
