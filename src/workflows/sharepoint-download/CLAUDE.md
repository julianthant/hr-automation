# sharepoint-download Workflow

One-shot utility for pulling a shared SharePoint / Excel Online file to a local `.xlsx`. Used by:

- The **dashboard queue-header download button** — always visible regardless of which workflow is selected. Wired to `POST /api/sharepoint-download/run` via `buildSharePointRosterDownloadHandler()`. Saves into `src/data/<YYYY-MM-DDTHH-MM-SS>-<suggested>.xlsx`.
- **emergency-contact pre-flight roster verification** — `runPreflight()` in `src/workflows/emergency-contact/workflow.ts` calls `downloadSharePointFile()` directly when `--roster-url` is passed, saving into `.tracker/rosters/` for the duration of the run.
- **`tsx src/workflows/emergency-contact/scripts/download-roster.ts <url>`** — standalone CLI wrapper for ad-hoc downloads into `.tracker/rosters/`.

## Intentionally not a kernel workflow

This directory lives under `src/workflows/` for co-location with the other automation flows, but it deliberately does **NOT**:

- Call `defineWorkflow()` — so it never registers with the kernel registry that backs `/api/workflow-definitions`.
- Emit tracker JSONL events — so `listWorkflows()` (which scans `.tracker/*.jsonl`) never sees it.
- Have a `schema.ts` / `enter.ts` / batch-mode plumbing — there's no batch here, just one file to fetch.

Net effect: the sharepoint-download "workflow" never appears in the TopBar workflow dropdown. That's by design — the download is an operator utility, not an HR record to track.

## Files

- `download.ts` — `downloadSharePointFile({ url, outDir, ... })`. Launches a headed browser, runs the full auth chain (Microsoft email prefill → UCSD Shibboleth → Duo → KMSI), then drives the Excel Online File menu via selectors from `src/systems/sharepoint/selectors.ts`. Returns the absolute path of the saved file.
- `handler.ts` — `buildSharePointRosterDownloadHandler({ outDir?, downloader?, getUrl? })`. Pure-ish factory for the dashboard HTTP endpoint; encapsulates the module-level in-flight lock and translates `downloadSharePointFile` outcomes into `{ status, body }` responses (200 / 400 / 409 / 500). Framework-agnostic so tests can invoke it without an HTTP harness.
- `index.ts` — Barrel exports.

## Auth reuse

All auth logic is shared with every other system. Do NOT re-implement:

- `fillSsoCredentials` + `clickSsoSubmit` from `src/auth/sso-fields.ts` — UCSD Shibboleth.
- `pollDuoApproval({ systemLabel: "SharePoint", ... })` from `src/auth/duo-poll.ts` — handles "Try Again" push-timeout retries and the "Yes, this is my device" trust prompt automatically.
- `microsoft.*` / `kmsi.*` / `excelOnline.*` / `fileMenu.*` selectors from `src/systems/sharepoint/selectors.ts` — see `src/systems/sharepoint/CLAUDE.md` for the step-by-step flow.

## Download location

The dashboard endpoint and standalone CLI **always** land bytes via `Playwright download.saveAs(outPath)` with `outPath` rooted inside the project tree (`src/data/` for dashboard, `.tracker/rosters/` for emergency-contact pre-flight). The `.playwright-cli/` directory is only used by the `playwright-cli` interactive tool during selector mapping — if you see an xlsx land there, it's a selector-mapping artifact, not a production download; delete it.

## Concurrency

`buildSharePointRosterDownloadHandler` keeps a module-level `rosterDownloadInFlight` flag. Concurrent invocations return HTTP 409 with an actionable error — the dashboard renders this as a warning toast. Duo approval requires a phone in hand, so stacking browsers is both wasteful and confusing.

## Gotchas

- **Endpoint name matters.** The dashboard fetches `/api/sharepoint-download/run` — renamed from the old `/api/emergency-contact/download-roster` (2026-04-22). Grep before adding any reference.
- **Never call from the kernel.** If you find yourself writing `defineWorkflow({ name: "sharepoint-download", ... })`, stop — you're about to add this to the dropdown and bake in tracker semantics that don't apply. If batch-style orchestration is genuinely needed later, define a new kernel workflow that *uses* `downloadSharePointFile` as a step, rather than promoting this one.
- **Env var required.** `ONBOARDING_ROSTER_URL` must be set (see `.env.example`) before the dashboard button can do anything. Missing env → HTTP 400 with a setup-time toast message.

## Lessons Learned

- **2026-04-22: Not every "workflow" belongs in the kernel.** Initially lived at `src/workflows/emergency-contact/sharepoint-download.ts` because emergency-contact was the first consumer. Once the dashboard button was added (for every workflow, not just emergency-contact), it became clear the helper is a cross-cutting utility that just happens to be tall enough to deserve its own directory. Promoted to `src/workflows/sharepoint-download/` with the explicit non-kernel rule above so it stays out of the dropdown while enjoying co-location with real workflows.
