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

## Retry safety

**Known idempotency gap (workflow bug — not a kernel concern).** Contract 2 makes retry a uniform kernel behavior: a retry re-runs the handler from step 0 with the pristine original input. That means the `transaction` step's UCPath Smart HR submit can fire twice if the first run succeeded server-side but failed before writing the terminal tracker row (e.g. network blip after submit).

The fix lives in this workflow, not the kernel: probe the UCPath Smart HR transactions list for an existing in-flight / saved transaction for this `(emplId, effectiveDate, templateCode)` before re-submitting. Pattern reference: separations already does this via `findExistingTerminationTransaction` (search `src/workflows/separations/`); mirror it for Smart HR hire transactions.

Until that probe lands, operators retrying onboarding are responsible for confirming UCPath doesn't already have a pending hire for the EID before clicking Retry. The kernel does not gate this — `supportsRetry` flags / structured "not retryable" errors are explicitly out of scope; idempotency belongs in the workflow.

## Gotchas

- SSN/DOB are optional (international students) but wage requires `$` prefix
- Appointment field: extracts just the number from "Casual/Restricted 5" → `"5"`
- Department number parsed from parenthesized text: `"Computer Science (000412)"` → `"000412"`
- PDF downloads run **in-process** against the already-authenticated CRM page (`pdf-download` step), not delegated to `crm-doc-download` — delegating would force a fresh CRM Duo + extra Chromium launch (~30–90 s) per item since the onboarding daemon's CRM session cannot be shared across daemons. The standalone `crm-doc-download` daemon exists for explicit CLI use only. Failed download is non-fatal; UCPath/I-9 continue.
- I-9 creation requires SSN, DOB, and departmentNumber — the workflow throws a clear error if any is missing for non-rehires
- Job end date defaults to `06/30/2026` in `src/config.ts` (`ANNUAL_DATES.jobEndDate`) — override via `ANNUAL_DATES_END` env var when the fiscal year rolls; onboarding `config.ts` re-exports it as `JOB_END_DATE`
- Rehire short-circuit: if `searchPerson` returns a match, the workflow records `rehire: "Yes"` + existing EIDs and exits before I-9/transaction
- Triple-browser setup (single mode): CRM page, UCPath page, I-9 page. CRM and UCPath need Duo; I-9 uses the same UCSD creds without Duo
- No Excel tracker — all observability flows through the dashboard JSONL. Run `npm run dashboard` in a separate terminal to watch

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
