# Onboarding Workflow

Automates full UC employee hiring: extracts data from ACT CRM, validates with Zod, searches UCPath for duplicates, creates Smart HR transactions, and tracks status in Excel.

## Files

- `schema.ts` — Zod `EmployeeData` schema (names, SSN, address, wage, appointment, dates)
- `extract.ts` — CRM field extraction from UCPath Entry Sheet using `FIELD_MAP` label mapping; also extracts dept/recruitment numbers from record page
- `enter.ts` — Builds `ActionPlan` for the 14-step Smart HR transaction (personal data, job data, comments, save/submit)
- `config.ts` — Constants: `UC_FULL_HIRE` template, `UCHRLY` comp rate code, `06/30/2026` end date
- `download.ts` — Fetches CRM record PDFs (Doc 1 + Doc 3) directly from the iDocs document server URL — no UI driving. Saves to `~/Downloads/onboarding/{Last, First Middle} EID/`
- `retry.ts` — `retryStep(name, fn, opts)` helper: retries with linear backoff, emits per-attempt error logs, throws `RetryStepError` after exhausting attempts
- `parallel.ts` — Batch mode: loads `batch.yaml` email list, launches N workers with 3 browsers each (CRM, UCPath, I-9). Pre-authenticates I-9 once per worker (no Duo)
- `workflow.ts` — Main orchestration: `withTrackedWorkflow` dashboard tracking with steps `crm-auth → extraction → pdf-download → ucpath-auth → person-search → i9-creation → transaction`. Enriches `updateData()` with employee fields so the dashboard detail grid shows Dept/Position/Wage/Eff Date/I-9 Profile. No Excel writes — dashboard JSONL is the only tracker.
- `index.ts` — Barrel exports

## Data Flow

```
batch.yaml / CLI email
  → CRM search (by email) → select latest "Offer Sent On"
  → Extract dept # and recruitment # from record page
  → Navigate to UCPath Entry Sheet, extract FIELD_MAP
  → Validate against EmployeeData Zod schema
  → Download Doc 1 + Doc 3 from iDocs viewer (direct PDF fetch)
  → UCPath Person Search (duplicate/rehire check → stop if found)
  → I-9 Complete: create employee profile, grab profileId
  → ActionPlan: Smart HR Transaction (UC_FULL_HIRE) with real I-9 profileId
  → Dashboard JSONL entries (.tracker/onboarding-*.jsonl)
```

## Gotchas

- SSN/DOB are optional (international students) but wage requires `$` prefix
- Appointment field: extracts just the number from "Casual/Restricted 5" → `"5"`
- Department number parsed from parenthesized text: `"Computer Science (000412)"` → `"000412"`
- PDF download failures are non-fatal — the workflow logs and continues (the transaction still needs to run even if PDFs are missing)
- I-9 creation requires SSN, DOB, and departmentNumber — the workflow throws a clear error if any is missing for non-rehires
- Job end date hardcoded to `06/30/2026` in config — update annually in `config.ts`
- Rehire short-circuit: if `searchPerson` returns a match, the workflow records `rehire: "Yes"` + existing EIDs and exits before I-9/transaction
- Triple-browser setup (single mode): CRM page, UCPath page, I-9 page. CRM and UCPath need Duo; I-9 uses the same UCSD creds without Duo
- No Excel tracker — all observability flows through the dashboard JSONL. Run `npm run dashboard` in a separate terminal to watch

## Verified Selectors

### ACT CRM record page (`/hr/ONB_ViewOnboarding?id=<recordId>`) — 2026-04-14
Visualforce table layout — `<tr>` with `<th class="labelCol">` label followed by `<td class="data2Col">` value. Extractable via `extractField(page, label)`:
- `Department` → e.g. `"HOUSING/DINING/HOSPITALITY (000412)"` (parse dept# from parens)
- `Recruitment Number` → e.g. `"10022932"`
- `Position Number`, `Pay Rate`, `First Day of Service (Effective Date)`, `Appointment (Expected Job) End Date`, `Employee First/Middle/Last Name`, `Address Line 1/2`, `City`, `State`, `Postal Code`, `Personal Email Address`, `Hire Type`, `Appointment Type`, `Title Code/Payroll Title`, `Working Title`, `Pay Cycle`, `Benefits Eligibility`, `FLSA Exemption Status`, `Union Representation`

### iDocs PDF viewer (CRM record page) — 2026-04-14
- Viewer iframe frame URL matches host `crickportal-ext.bfs.ucsd.edu` + path `/iDocsForSalesforce/Content/pdfjs/web/PDFjsViewer.aspx`
- Query params: `h=<recordHash>` (unique per record), `c=<totalDocCount>`
- **Direct fetch endpoint** (preferred — no UI driving): `https://crickportal-ext.bfs.ucsd.edu/iDocsForSalesforce/iDocsForSalesforceDocumentServer?i=<0-based-idx>&h=<recordHash>` — returns `application/pdf` with `Content-Disposition: inline; filename=...` using browser-context cookies
- Use `page.context().request.get(url)` — shares session cookies set when the PDF.js iframe originally loaded
- For UI-based download (unused now): `#secondaryToolbarToggle` → Tools menu; no built-in download button, so direct fetch is the only clean path

## Lessons Learned

- **2026-04-14: iDocs PDFs fetch faster than they render** — Driving the PDF.js viewer UI (click Next Doc, scroll, trigger download) is brittle across Salesforce Canvas + nested iframes + PDF.js state. The viewer loads each PDF from `/iDocsForSalesforceDocumentServer?i=<idx>&h=<hash>` using context cookies — `page.context().request.get(url)` returns the raw PDF directly. One HTTP round-trip replaces ~5 UI steps and ~3s/doc of wait time. Extract `h` from the PDF.js iframe URL in `page.frames()` after the record page loads.
- **2026-04-14: I-9 creation is no longer mocked** — The `MOCK_I9` hardcode was removed. Real `createI9Employee()` runs between `person-search` and `transaction`; the returned `profileId` flows into `buildTransactionPlan()` so the UCPath Comments/Personal Data steps reference the actual I-9. I-9 login has no Duo — pre-authenticate once per worker in parallel mode, fall back to per-run login in single mode.
- **2026-04-14: Every phase is retry-wrapped** — `retryStep(name, fn, { attempts, backoffMs, logPrefix, onRetry })` retries transient failures and emits per-attempt error logs to the dashboard. When a step exhausts attempts, it throws `RetryStepError` which propagates to `withTrackedWorkflow`'s catch and marks the entry `failed` with a meaningful step name in the error.
- **2026-04-14: Dashboard is the source of truth** — `onboarding-tracker.xlsx` and `tracker.ts` were deleted. All fields the tracker used to show (dept #, position #, wage, I-9 profile, etc.) are now pushed into `updateData()` so the dashboard's detail grid shows them. Dashboard `WF_CONFIG.onboarding.detailFields` has 8 cells in a 2-row grid: Employee, Email, Dept #, Position #, Wage, Eff Date, I9 Profile, Elapsed.
