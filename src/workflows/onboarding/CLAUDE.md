# Onboarding Workflow

Automates full UC employee hiring: extracts data from ACT CRM, validates with Zod, searches UCPath for duplicates, searches I9 before creating a profile, creates Smart HR transactions.

**Kernel-based (daemon + pool + single).** As of 2026-04-22, CLI default is **daemon mode** via `runOnboardingCli` → `ensureDaemonsAndEnqueue(onboardingWorkflow, [{email}, ...])`. Each alive daemon is one long-lived single-worker Session (3 browsers: CRM + UCPath + I9; 2 Duos since I9 is SSO no-2FA) that claims emails off the shared queue `.tracker/daemons/onboarding.queue.jsonl` via an atomic `fs.mkdir` mutex. Multiple alive daemons race for items — that's how parallelism works in daemon mode (no re-Duo between items). For N-way throughput, start N daemons with `-p N`.

Legacy in-process paths are preserved via `--direct`:
- `--dry-run` → `runOnboardingDryRun` (CRM only, imperative — auto-forces `--direct`)
- `--batch` → `runParallel` reads `batch.yaml`, pool mode (auto-forces `--direct`)
- N positional emails under `--direct` → `runOnboardingPositional` (kernel pool, N Sessions, 2N Duos)
- 1 positional email under `--direct` → `runOnboarding` → `runWorkflow(onboardingWorkflow, {email})`

The kernel owns browser launch, auth chain, per-item `withTrackedWorkflow` wrapping, SIGINT cleanup, screenshot on failure. Daemon mode wraps the same `runOneItem` primitive — per-item tracker output is byte-identical to `--direct` single mode.

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
- `download.ts` — Fetches CRM record PDFs (Doc 1 + Doc 3) directly from iDocs document server URL. Saves to `~/Downloads/onboarding/{Last, First Middle} EID/`
- `retry.ts` — `retryStep(name, fn, opts)` helper: linear backoff, per-attempt error logs, throws `RetryStepError` after exhausting attempts. Used only by the dry-run branch in `workflow.ts` (no `ctx` available there). Kernel-side callsites use `ctx.retry` instead
- `workflow.ts` — Kernel definition (`onboardingWorkflow`) + CLI adapters: `runOnboarding` (legacy single, `--direct`), `runOnboardingCli` (daemon-mode default — wraps `ensureDaemonsAndEnqueue`). Handler runs 5 phases across CRM / UCPath / I9 with `ctx.step` wrapping. Dry-run branch bypasses kernel (CRM only); daemon-mode dry-run falls back to the same per-email sequential dry-run
- `parallel.ts` — CLI adapter for `--batch` mode (`runParallel`). Loads `batch.yaml` email list and delegates to `runWorkflowBatch(onboardingWorkflow, items, { poolSize, deriveItemId, onPreEmitPending })` — kernel owns workers, auth, fan-out
- `positional.ts` — CLI adapter for positional multi-email mode (`runOnboardingPositional`). Takes emails directly from the CLI (no batch file) and delegates to `runWorkflowBatch` with `poolSize = opts.poolSize ?? min(N, 4)`
- `index.ts` — Barrel exports

## Kernel Config

| Field | Value | Why |
|-------|-------|-----|
| `systems` | `[crm, ucpath, i9]` — each wraps its login fn to throw on false | 3 independent auth systems |
| `steps` | `["crm-auth", "extraction", "pdf-download", "ucpath-auth", "person-search", "i9-creation", "transaction"] as const` | Registered to the dashboard registry at `defineWorkflow` time |
| `authChain` | `"sequential"` | CRM work happens before UCPath auth; sequential avoids wasting Duo prompts on systems we might not reach (rehire case). I9 auth has no Duo (SSO without 2FA) so 2 Duos per run/worker, not 3. |
| `batch` | `{ mode: "pool", poolSize: 4, preEmitPending: true }` | Enables `runWorkflowBatch(onboardingWorkflow, items)` to run through `runWorkflowPool` (N workers, shared queue). `poolSize: 4` is the default; the CLI's `--workers N` overrides via `RunOpts.poolSize`. Single-mode `runWorkflow` ignores `batch`. |
| `tiling` | `"auto"` (kernel picks for multi-system) | 3 browsers tiled then fullscreened; bringToFront per system during auth |
| `detailFields` | labeled (Employee, Email, Dept #, Position #, Wage, Eff Date, I9 Profile) + `getName`/`getId` resolvers | Rich detail panel populated via `ctx.updateData(...)` across the 5 phases |

## Data Flow

**Single mode:**
```
CLI: npm run onboarding <email>
  → runOnboarding (CLI adapter)
    → if --dry-run: runOnboardingDryRun (CRM only, imperative)
    → else: runWorkflow(onboardingWorkflow, { email })
      → Kernel Session.launch: 3 browsers, sequential auth chain (2 Duos: CRM + UCPath; I9 SSO no-Duo)
      → Handler phase 1 "crm-auth" + CRM search + "extraction" + updateData
      → Handler phase 2 "pdf-download" (non-fatal)
      → Handler phase 3 "ucpath-auth" + "person-search"
        → rehire? return early with status: "Rehire"
      → Handler phase 4 "i9-creation"
        → search I9 by SSN first; create only if not found
      → Handler phase 5 "transaction" → executes ActionPlan → status: "Done"
```

**Pool mode — positional emails:**
```
CLI: npm run onboarding <email1> <email2> ...
  → runOnboardingPositional(emails, { poolSize?: opts.workers }) (CLI adapter)
    → runWorkflowBatch(onboardingWorkflow, items, { poolSize: opts.workers ?? min(N, 4), deriveItemId: i => i.email, onPreEmitPending })
```

**Pool mode — batch.yaml file:**
```
CLI: npm run onboarding:batch -- --workers <N>
  → runParallel(N) (CLI adapter)
    → loadBatchFile → emails: string[]
    → runWorkflowBatch(onboardingWorkflow, items, { poolSize: N, deriveItemId: i => i.email, onPreEmitPending })
      → kernel registers pending rows for every email (dashboard shows full queue)
      → kernel launches min(N, emails.length) Sessions in parallel
      → each Session auths CRM → UCPath → I9 sequentially (2 Duos each)
      → workers pull emails from the shared queue; each item runs the same handler
        under withLogContext + withTrackedWorkflow wrapping
      → kernel closes all Sessions at the end; batch result = { total, succeeded, failed, errors }
```

## Daemon Mode Notes

- **One daemon = one worker, 2 Duos once.** A daemon holds 3 browsers + a Session across invocations. First launch costs CRM Duo + UCPath Duo (≈1-2 min); every subsequent email skips both. Biggest wall-clock savings of any converted workflow.
- **Parallelism = N daemons, not pool mode.** The workflow's `batch: { mode: "pool", poolSize: 4 }` only governs the legacy `--direct` path (used by `--batch` and positional `--direct`). Under daemon mode, each daemon is a single-worker process; the shared queue + atomic claim mutex distribute items. Run `npm run onboarding a@uc b@uc c@uc -- -p 3` to spawn 3 daemons the first time, or combine: `-p 1` first (cheap), then `-n` on later invocations to add capacity on demand.
- **Flags that auto-force `--direct`:**
  - `--dry-run` — short-circuits CRM-only before launching the full session. Not worth warming a daemon for.
  - `--batch` — reads `batch.yaml` in-process. If you want daemon-mode batch processing, pass emails positionally.
  An announcing log line fires when the override is implicit (e.g. `[onboarding] --batch forces --direct mode`).
- **Rehire short-circuit still works.** Daemon handler is the same `onboardingWorkflow` handler; rehire detection in the `person-search` step returns early with `status: "Rehire"` before I-9/transaction. The daemon stays alive for the next email.
- **Tracker byte-parity.** Per-item JSONL emissions are identical between daemon mode and `--direct` single mode — the daemon calls `runOneItem` under `withBatchLifecycle({ ownSigint: false })`, so instance/run IDs, `authTimings`, and step entries all flow through the same code path.

## Parallel Mode Notes (`--direct` path only)

- **2 Duos per worker, not 3**: I9 uses UCSD SSO without 2FA. Only CRM + UCPath trigger Duo prompts. With `poolSize = 4`, the user approves **8 Duos total** during worker startup (4 workers × 2 Duos each). The kernel's `Session.launch` stages these per-worker; `bringToFront()` surfaces the active tab before each Duo.
- **Dry-run is single-mode only**: `runParallel` with `options.dryRun = true` logs a warning and returns; `runOnboardingPositional` with `dryRun` just logs the email list. The real-run imperative CRM-only dry-run lives in `workflow.ts`'s `runOnboardingDryRun` and fires from the single-email branch of the `onboarding` CLI command (`npm run onboarding:dry <email>`).
- **Per-worker browser cleanup**: the kernel's Session owns browser teardown per worker via `session.close()` in `runWorkflowPool`'s `finally` block. Previously `parallel.ts` explicitly "left browsers open for observability"; now all worker browsers close after the batch finishes (same as any kernel workflow).

## Gotchas

- SSN/DOB are optional (international students) but wage requires `$` prefix
- Appointment field: extracts just the number from "Casual/Restricted 5" → `"5"`
- Department number parsed from parenthesized text: `"Computer Science (000412)"` → `"000412"`
- PDF download failures are non-fatal — the workflow logs and continues (the transaction still needs to run even if PDFs are missing)
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

- **2026-04-23: Removed step-cache + idempotency primitives in favor of live-page probes.** The `extraction` step no longer uses `stepCacheGet`/`stepCacheSet` — CRM record scraping runs on every retry (~2 min cost, deemed acceptable vs the correctness risk of serving stale data when the user fixed a bad CRM record between runs). The `transaction` step no longer uses `hashKey`/`hasRecentlySucceeded`/`recordSuccess` — there is no tracker-side dupe-protection on the UCPath Smart HR submit. If this becomes a problem in practice, the replacement pattern is a pre-submit scan of the Smart HR Transactions list (see separations' `findExistingTerminationTransaction`). `pdf-download`'s `Doc{N}-*.pdf` skip-if-all-present branch inside `downloadCrmDocuments` is preserved — that's a filesystem-level check, not tracker-side state.
- **2026-04-21: Batch-level instance + per-worker authTimings.** `runWorkflowPool` now runs inside `withBatchLifecycle` (`src/core/batch-lifecycle.ts`). One `workflow_start` / `workflow_end` per batch invocation — the dashboard SessionPanel now shows ONE `Onboarding N` row for a batch of N instead of N separate rows. Each worker gets its own `SessionObserver` (via `makeObserver('w${i}')`) and its own `authTimings[]` snapshot taken AFTER awaiting `session.page(sys.id)` for every declared system (guarantees interleaved-auth completion before snapshot). Those per-worker timings are passed to every `runOneItem` call that worker processes, so each per-item row shows real `auth:crm` / `auth:ucpath` / `auth:i9` durations. SIGINT fans out `failed` rows for every un-terminated item. No change to parallel semantics — topology is still per-worker browsers.
- **2026-04-14: iDocs PDFs fetch faster than they render** — Driving the PDF.js viewer UI (click Next Doc, scroll, trigger download) is brittle across Salesforce Canvas + nested iframes + PDF.js state. The viewer loads each PDF from `/iDocsForSalesforceDocumentServer?i=<idx>&h=<hash>` using context cookies — `page.context().request.get(url)` returns the raw PDF directly. One HTTP round-trip replaces ~5 UI steps and ~3s/doc of wait time. Extract `h` from the PDF.js iframe URL in `page.frames()` after the record page loads.
- **2026-04-14: I-9 creation is no longer mocked** — The `MOCK_I9` hardcode was removed. Real `createI9Employee()` runs between `person-search` and `transaction`; the returned `profileId` flows into `buildTransactionPlan()` so the UCPath Comments/Personal Data steps reference the actual I-9. I-9 login has no Duo — pre-authenticate once per worker in parallel mode, fall back to per-run login in single mode.
- **2026-04-14: Every phase is retry-wrapped** — `retryStep(name, fn, { attempts, backoffMs, logPrefix, onRetry })` retries transient failures and emits per-attempt error logs to the dashboard. When a step exhausts attempts, it throws `RetryStepError` which propagates out of the handler; the kernel's step wrapper marks the entry `failed` with a meaningful step name. (With the kernel in place, `ctx.retry(fn, { attempts, backoffMs })` is a lighter alternative for simple cases.)
- **2026-04-14: Dashboard is the source of truth** — `onboarding-tracker.xlsx` and `tracker.ts` were deleted. All fields the tracker used to show (dept #, position #, wage, I-9 profile, etc.) are now pushed into `ctx.updateData(...)` so the dashboard's detail grid shows them. Detail fields declared on `defineWorkflow` (7 labeled entries) plus `getName`/`getId` resolvers drive the dashboard detail panel.
- **2026-04-15: Migrated single-mode to kernel.** `runOnboarding` is a CLI adapter over `runWorkflow(onboardingWorkflow, { email })`. Don't reintroduce raw `launchBrowser` / `withTrackedWorkflow` in the single-mode handler.
- **2026-04-17: Migrated parallel onto kernel pool mode.** Added `batch: { mode: "pool", poolSize: 4, preEmitPending: true }` to the `defineWorkflow` call; rewrote `parallel.ts` as a thin shim over `runWorkflowBatch(onboardingWorkflow, items, { poolSize, deriveItemId: i => i.email, onPreEmitPending })`; deleted `workflow-legacy.ts` (329 lines). `OnboardingOptions` now only carries `dryRun` — dropped `crmPage`/`ucpathPage`/`i9Page`/`logPrefix`, which only existed to route into the legacy path. I9 pre-auth (line 75-83 of old `parallel.ts`) is now handled by the kernel's sequential auth chain — I9 system's `login` fires after CRM and UCPath, no 2FA, so same latency. Each worker's Session = 3 browsers = 2 Duos (CRM + UCPath); `poolSize × 2` Duos total at startup. Live verification deferred: 2N parallel Duo approvals can't be exercised here; tests cover the kernel plumbing. Matching kronos-reports precedent, both pool-mode features (per-item `onPreEmitPending` + paired runId) carry over automatically.
- **2026-04-16: I9 — search before creating.** The create path blows up if a matching SSN already has a profile; always search I9 by SSN first and short-circuit to the existing profileId if found.
- **2026-04-16: I9 — dismiss the datepicker overlay before clicking Worksite dropdown.** `Escape` key does nothing; force-hide the overlay via inline style.
- **2026-04-16: I9 — handle Duplicate Employee dialog.** Select the first row radio, click "View/Edit", then navigate to `?saveAndContinue=true` on the profile URL to reveal the radio section.
- **2026-04-16: I9 — wait for `/employee/profile/{id}` URL before extracting profileId.** Prior code grepped the DOM before redirect completed.
- **2026-04-16: UCPath — `pt_modalMask` intercepts tab clicks.** Dismiss the modal mask explicitly before each tab navigation.
- **2026-04-16: UCPath — visit all 4 tabs before Save & Submit.** The Save button stays disabled until Personal Data → Job Data → Earns Dist → Employee Experience have all been visited. After filling Initiator Comments on the final tab, re-click Personal Data before saving.
- **2026-04-16: UCPath — Comp Rate Code + Compensation Rate via accessible-name selectors.** Use `getByRole("textbox", { name: ... })`. After filling, press Tab to blur and trigger validation. Compensation Frequency must be explicitly filled `"H"` (Hourly) if empty.
- **2026-04-16: UCPath — fill preferred name fields even when only legal name exists.** Mirror legal names into preferred-name fields when no lived name is supplied.
- **2026-04-16: Auth — 500ms settle delay after SSO credential fill.** Submit fires before the form JS registers values otherwise.
- **2026-04-16: Kernel — auth retry on Duo timeout.** `Session.launch` refreshes the page and retries login up to 3 attempts on auth failure.
- **2026-04-16: Kernel — `bringToFront()` before each system's login.** Multi-browser tiling hides background tabs; the active one must surface before the user approves Duo.
- **2026-04-17: Kernel handler migrated from `retryStep` to `ctx.retry`.** Inside the kernel `handler`, every `retryStep("name", fn, opts)` call now uses `ctx.retry(fn, opts)`. The step name arg is redundant (outer `ctx.step(...)` already announces it to logs + dashboard), and `logPrefix` has no equivalent (per-attempt error logs are no longer prefixed; they were redundant inside `ctx.step` anyway). `ctx.retry` rethrows the underlying error verbatim on exhaustion — the transaction-step catch block no longer checks `instanceof RetryStepError`, just `TransactionError` + generic fallback via `errorMessage()`. `retry.ts` + `index.ts`'s `retryStep` re-export stay in place for the dry-run branch in `workflow.ts`, which is imperative (no `ctx`).
- **2026-04-22: Converted to daemon mode.** `runOnboardingCli` adapter + registration in `src/cli-daemon.ts` WORKFLOWS map. CLI default is now daemon-mode enqueue; legacy paths reachable via `--direct` (positional single/pool) or forced via `--dry-run` / `--batch` (auto-force). Heaviest per-daemon cost of any converted workflow (3 browsers, 2 Duos) but biggest re-Duo savings per subsequent email. Daemon parallelism is via N alive daemons (`-p N`) racing for the shared queue — orthogonal to `batch.mode: "pool"` which still drives the legacy `--direct --batch` path. `onboarding`, `separations`, `work-study`, `eid-lookup` are the converted set as of this date.
