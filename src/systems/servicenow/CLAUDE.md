# ServiceNow / UCSD Employee Center

UCSD's HR Employee Center is hosted on ServiceNow at
`support.ucsd.edu/esc`. Authentication is UCSD SSO + Duo (same
TritON SAML IdP as UCPath). This module currently covers ONE form: the
HR General Inquiry catalog item, used by `oath-upload` to file a
ticket after every paper-roster signing ceremony is completed in
UCPath.

## Files

- `selectors.ts` — `hrInquiry`, `ssoFields` selector groups
- `navigate.ts` — `gotoHrInquiryForm`, `verifyOnInquiryForm`,
  `HR_INQUIRY_FORM_URL`
- `SELECTORS.md` — auto-generated catalog (`npm run selectors:catalog`)
- `LESSONS.md` — empty initially

## Auth

`loginToServiceNow` in `src/auth/login.ts` mirrors `loginToUCPath`:
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

- **Specifically combobox is a ServiceNow typeahead.** It doesn't
  support `selectOption`. Implementation: type the search term, wait
  for the dropdown suggestion list, click the matching option.
  `oath-upload`'s `fill-form.ts` encapsulates this pattern.
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

(empty as of 2026-05-01)
