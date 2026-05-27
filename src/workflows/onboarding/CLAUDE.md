# Onboarding Workflow

Automates full UC employee hiring: extracts data from ACT CRM, validates with Zod, searches UCPath for duplicates, searches I9 before creating a profile, creates Smart HR transactions.

**Kernel-based (daemon mode default).** Each alive daemon is one long-lived single-worker Session (3 browsers: CRM + UCPath + I9; 2 Duos since I9 is SSO no-2FA) that claims emails from the shared SQLite `tasks` queue via an atomic transaction. `.tracker/daemons/onboarding.queue.jsonl` is append-only audit/history — not read for state (queue authority is SQLite). There is no public package-script launch path right now; add a dashboard input run before exposing this workflow to operators again.

The kernel owns browser launch, auth chain, per-item `withTrackedWorkflow` wrapping, SIGINT cleanup, screenshot on failure. Daemon mode wraps the same `runOneItem` primitive — per-item tracker output is byte-identical to single-mode `runWorkflow`.

## Selector intelligence

This workflow touches three systems: **crm**, **ucpath**, **i9**.

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"crm extract field"`, `"ucpath person search"`, `"i9 section 1"`).
- Per-system lessons (read before re-mapping):
  - [`src/systems/crm/LESSONS.md`](../../systems/crm/LESSONS.md)
  - [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
  - [`src/systems/i9/LESSONS.md`](../../systems/i9/LESSONS.md)
- Per-system catalogs (auto-generated):
  - [`src/systems/crm/SELECTORS.md`](../../systems/crm/SELECTORS.md)
  - [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md)
  - [`src/systems/i9/SELECTORS.md`](../../systems/i9/SELECTORS.md)

## Files

- `schema.ts` — Zod `EmployeeData` schema (names, SSN, address, wage, appointment, dates)
- `extract.ts` — CRM field extraction from UCPath Entry Sheet using `FIELD_MAP` label mapping; also extracts dept/recruitment numbers from record page
- `enter.ts` — Builds `ActionPlan` for the 14-step Smart HR transaction (personal data, job data, comments, save/submit)
- `config.ts` — Constants: `UC_FULL_HIRE` template, `UCHRLY` comp rate code, `JOB_END_DATE` sourced from `ANNUAL_DATES.jobEndDate` (override via `ANNUAL_DATES_END` env var)
- `workflow.ts` — CRM extraction, passive delegation to `crm-doc-download`, UCPath/I-9 onboarding transaction. Kernel definition (`onboardingWorkflow`) + adapters: `runOnboarding` (in-process single — for tests/scripts), `runOnboardingCli` (internal daemon adapter). Handler runs phases across CRM / UCPath / I9 with `ctx.step` wrapping.
- `index.ts` — Barrel exports

## Kernel Config

| Field | Value | Why |
|-------|-------|-----|
| `systems` | `[crm, ucpath, i9]` — each wraps its login fn to throw on false | 3 independent auth systems |
| `steps` | `["crm-auth", "crm-search", "extraction", "pdf-download", "ucpath-auth", "person-search", "i9-creation", "transaction"] as const` — matches `onboardingSteps` in `workflow.ts` |
| `batch` | `{ mode: "pool", poolSize: 4, preEmitPending: true }` | Enables in-process `runWorkflowBatch(onboardingWorkflow, items)` (tests, scripts, or custom callers) → `runWorkflowPool`. Daemon processing uses one worker per daemon. Single-item `runWorkflow` ignores `batch`. |
| `tiling` | `"auto"` (kernel picks for multi-system) | 3 browsers tiled then fullscreened; bringToFront per system during auth |
| `detailFields` | `email`, `departmentNumber`, `positionNumber`, `wage`, `effectiveDate`, `i9ProfileId` (see `workflow.ts`) + `getName`/`getId` | Detail panel populated via `ctx.updateData(...)` across phases |

## Data Flow

**Future dashboard input run:**
```
InputRunPanel → /api/enqueue
  → ensureDaemonsAndEnqueue(onboardingWorkflow, [{email}, ...])
      - Discovers alive daemons via .tracker/daemons/onboarding-*.lock.json + /whoami liveness
      - Spawns a daemon when none is alive — Duo once per new daemon (CRM + UCPath)
      - Inserts SQLite task rows and appends enqueue audit events to .tracker/daemons/onboarding.queue.jsonl
      - POST /wake to every alive daemon; daemons race to claim via atomic SQLite transaction
      - Each daemon runs the handler below in a loop (one Session, Duos once, reused)
```

**Handler (runs inside each daemon's loop, or via `runOnboarding` for tests):**
```
runWorkflow(onboardingWorkflow, { email })
  → Kernel Session.launch: 3 browsers, sequential auth chain (2 Duos: CRM + UCPath; I9 SSO no-Duo)
  → Phase CRM: `crm-auth` → `crm-search` → `extraction` + updateData
  → `pdf-download` delegates `crm-doc-download` as a passive child row (non-fatal)
  → Phase UCPath: `ucpath-auth` + `person-search`
    → rehire? return early with status: "Rehire"
  → Phase I9: `i9-creation` (search by SSN first; create only if not found)
  → `transaction` → executes ActionPlan → status: "Done"
```

## Daemon Mode Notes

- **One daemon = one worker, 2 Duos once.** A daemon holds 3 browsers + a Session across invocations. First launch costs CRM Duo + UCPath Duo (≈1-2 min); every subsequent email skips both. Biggest wall-clock savings of any converted workflow.
- **Parallelism = N daemons.** The workflow's `batch: { mode: "pool", poolSize: 4 }` is for in-process pool callers (`runWorkflowBatch` → `runWorkflowPool`). Under **daemon** mode, each daemon is a single-worker process; the shared SQLite tasks queue + atomic claim distribute items.
- **Rehire short-circuit still works.** Daemon handler is the same `onboardingWorkflow` handler; rehire detection in the `person-search` step returns early with `status: "Rehire"` before I-9/transaction. The daemon stays alive for the next email.
- **Tracker byte-parity.** Per-item JSONL emissions are identical between daemon mode and in-process single mode — the daemon calls `runOneItem` under `withBatchLifecycle({ ownSigint: false })`, so instance/run IDs, `authTimings`, and step entries all flow through the same code path.

## Retry safety

**Known idempotency gap (workflow bug — not a kernel concern).** Contract 2 makes retry a uniform kernel behavior: a retry re-runs the handler from step 0 with the pristine original input. That means the `transaction` step's UCPath Smart HR submit can fire twice if the first run succeeded server-side but failed before writing the terminal tracker row (e.g. network blip after submit).

The fix lives in this workflow, not the kernel: probe the UCPath Smart HR transactions list for an existing in-flight / saved transaction for this `(emplId, effectiveDate, templateCode)` before re-submitting. Pattern reference: separations already does this via `findExistingTerminationTransaction` (search `src/workflows/separations/`); mirror it for Smart HR hire transactions.

Until that probe lands, operators retrying onboarding are responsible for confirming UCPath doesn't already have a pending hire for the EID before clicking Retry. The kernel does not gate this — `supportsRetry` flags / structured "not retryable" errors are explicitly out of scope; idempotency belongs in the workflow.

## Gotchas

- SSN/DOB are optional (international students) but wage requires `$` prefix
- Appointment field: extracts just the number from "Casual/Restricted 5" → `"5"`
- Department number parsed from parenthesized text: `"Computer Science (000412)"` → `"000412"`
- PDF downloads are now delegated to `crm-doc-download` under `parentRunId = onboarding runId`. Onboarding does not wait for completion; failed delegation is non-fatal and UCPath/I-9 continue.
- I-9 creation requires SSN, DOB, and departmentNumber — the workflow throws a clear error if any is missing for non-rehires
- Job end date defaults to `06/30/2026` in `src/config.ts` (`ANNUAL_DATES.jobEndDate`) — override via `ANNUAL_DATES_END` env var when the fiscal year rolls; onboarding `config.ts` re-exports it as `JOB_END_DATE`
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

### I9 Complete — 2026-04-16
- Datepicker overlay dismiss: `document.querySelector('.datepicker-overlay')?.style.setProperty('display', 'none', 'important')` (Escape key does not work)
- Duplicate Employee dialog: select first row radio, click "View/Edit", then navigate to `<profileUrl>?saveAndContinue=true` to reveal the radio section
- Post-save URL wait: wait for `/employee/profile/{id}` before extracting profileId
- Search-first: look up existing profile by SSN before creating; skip creation entirely if found

### UCPath Smart HR Transaction — 2026-04-16
- `pt_modalMask` intercepts tab clicks — dismiss via `document.querySelectorAll('.ptModalMask').forEach(el => el.style.display = 'none')` before each tab click
- Comp Rate Code: `getByRole("textbox", { name: "Comp Rate Code" })` + press Tab to blur and trigger validation
- Compensation Rate: `getByRole("textbox", { name: "Compensation Rate" })` + press Tab (this was the actual Elena fix — value must trigger validation to enable Save)
- Compensation Frequency: explicitly fill `"H"` (Hourly) if empty
- Preferred name fields: always fill (mirror legal names when no lived name)
- Tab order before Save & Submit: must visit Personal Data → Job Data → Earns Dist → Employee Experience; after filling Initiator Comments re-click Personal Data before Save
- Save & Submit often arrives disabled — force-click via `{ force: true }` to bypass the disabled state

## Lessons Learned

- **Lesson maintenance rule:** Search this section plus CRM/UCPath/I9 system docs before adding onboarding lessons. Merge old retry/kernel/selector notes into the current daemon + kernel model instead of preserving obsolete `retryStep` history.
- **No tracker-side cache/idempotency.** CRM extraction re-scrapes on retry, and UCPath Smart HR submit has no tracker-side duplicate guard. If duplicate submits become a real issue, add a live Smart HR transaction-list probe like separations; do not restore `stepCacheGet`, `hasRecentlySucceeded`, or `recordSuccess`.
- **2026-05-25: Public start path removed until a dashboard input run is added.** `npm run onboarding` is retired. Do not re-expose this workflow through package scripts; add an `InputRunPanel` parser if operators need direct onboarding starts again.
- **Daemon mode is the queue path.** `runOnboardingCli` enqueues into the shared SQLite tasks queue for internal callers; each daemon is one worker with 3 browsers and 2 Duos. In-process pool mode remains for tests/programmatic callers only.
- **Pool/batch lifecycle is kernel-owned.** `runWorkflowPool` runs inside `withBatchLifecycle`; each worker snapshots auth timings after awaiting every declared system page, then passes those timings into `runOneItem` so per-email rows show real auth durations.
- **iDocs PDF download should use direct fetch.** Extract `h` and document count from the PDF.js iframe URL, then fetch `/iDocsForSalesforceDocumentServer?i=<idx>&h=<hash>` with `page.context().request.get(url)`. Do not drive the PDF.js UI for downloads.
- **I-9 creation is real and search-first.** Search by SSN before creating; duplicate-profile dialogs require selecting the first row, clicking View/Edit, and navigating with `?saveAndContinue=true`. Wait for `/employee/profile/{id}` before reading `profileId`.
- **UCPath Smart HR tab/field quirks:** Dismiss `pt_modalMask` before tab clicks, visit Personal Data -> Job Data -> Earns Dist -> Employee Experience before save, re-click Personal Data after comments, fill comp-rate fields by accessible textbox name, press Tab to trigger validation, and mirror legal names into preferred-name fields when no lived name exists.
- **Dashboard is the tracker.** `onboarding-tracker.xlsx` and workflow-local tracker writes are gone; populate `detailFields` via `ctx.updateData` and watch runs in the JSONL dashboard.
- **Auth/browser stability belongs in core.** SSO settle delay, Duo retry, and `bringToFront()` are kernel/auth-layer behavior. Do not add workflow-local browser-launch or auth retries.
