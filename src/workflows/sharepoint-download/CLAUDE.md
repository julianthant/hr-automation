# sharepoint-download Workflow

One-shot utility for pulling a shared SharePoint / Excel Online file to a local `.xlsx`. Used by:

- The **dashboard queue-header download dropdown** — always visible regardless of which workflow is selected. Each menu item is one row from `registry.ts`. Selecting an option hits `POST /api/sharepoint-download/run { id }` via `buildSharePointRosterDownloadHandler()`; the dropdown itself is populated by `GET /api/sharepoint-download/list` via `buildSharePointListHandler()`. Downloads land in `src/data/<YYYY-MM-DDTHH-MM-SS>-<suggested>.xlsx` (overridable per-spec via `spec.outDir`).
- **emergency-contact pre-flight roster verification** — `runPreflight()` in `src/workflows/emergency-contact/workflow.ts` calls `downloadSharePointFile()` directly when `--roster-url` is passed, saving into `.tracker/rosters/` for the duration of the run.
- **`tsx src/workflows/emergency-contact/scripts/download-roster.ts <url>`** — standalone CLI wrapper for ad-hoc downloads into `.tracker/rosters/`.

## Intentionally not a kernel workflow

This directory lives under `src/workflows/` for co-location with the other automation flows, but it deliberately does **NOT**:

- Call `defineWorkflow()` — so it never registers with the kernel registry that backs `/api/workflow-definitions`.
- Emit tracker JSONL events — so `listWorkflows()` (which scans `.tracker/*.jsonl`) never sees it.
- Have a `schema.ts` / `enter.ts` / batch-mode plumbing — there's no batch here, just one file to fetch.

Net effect: the sharepoint-download "workflow" never appears in the TopBar workflow dropdown. That's by design — the download is an operator utility, not an HR record to track.

## Files

- `download.ts` — `downloadSharePointFile({ url, outDir, ... })`. Launches a headed browser, runs the full auth chain (Microsoft email prefill → UCSD Shibboleth → Duo → KMSI), then drives the Excel Online File menu via selectors from `src/systems/sharepoint/selectors.ts`. Returns the absolute path of the saved file. Knows nothing about the registry — it's a pure URL-in / file-out helper.
- `registry.ts` — `SHAREPOINT_DOWNLOADS: readonly SharePointDownloadSpec[]`. Single source of truth for the dropdown. Each spec: `{ id, label, description?, envVar, outDir? }`. `id` is the slug passed in the POST body; `envVar` is the `process.env` key holding the URL. Adding a spreadsheet is one new entry here + one line in `.env.example`.
- `handler.ts` — Two factories:
  - `buildSharePointListHandler({ getEnv? })` — returns `() => SharePointDownloadListItem[]` (registry rows + `configured: boolean` derived from env). Backs `GET /api/sharepoint-download/list`.
  - `buildSharePointRosterDownloadHandler({ outDir?, downloader?, getEnv? })` — returns `(input: { id? }) => Promise<RosterDownloadResponse>`. Looks up the spec by `input.id`, reads `process.env[spec.envVar]`, invokes `downloadSharePointFile`. Encapsulates the module-level in-flight lock (one browser at a time across ALL ids — a Duo-tap resource that doesn't parallelize) and the HTTP status taxonomy: 200 success / 400 missing id or unset env / 404 unknown id / 409 in-flight / 500 helper threw. Framework-agnostic so tests can invoke it without an HTTP harness.
- `index.ts` — Barrel exports.

## Auth reuse

All auth logic is shared with every other system. Do NOT re-implement:

- `fillSsoCredentials` + `clickSsoSubmit` from `src/auth/sso-fields.ts` — UCSD Shibboleth.
- `pollDuoApproval({ systemLabel: "SharePoint", ... })` from `src/auth/duo-poll.ts` — handles "Try Again" push-timeout retries and the "Yes, this is my device" trust prompt automatically.
- `microsoft.*` / `kmsi.*` / `excelOnline.*` / `fileMenu.*` selectors from `src/systems/sharepoint/selectors.ts` — see `src/systems/sharepoint/CLAUDE.md` for the step-by-step flow.

## Download location

The dashboard endpoint and standalone CLI **always** land bytes via `Playwright download.saveAs(outPath)` with `outPath` rooted inside the project tree (`src/data/` for dashboard, `.tracker/rosters/` for emergency-contact pre-flight). The `.playwright-cli/` directory is only used by the `playwright-cli` interactive tool during selector mapping — if you see an xlsx land there, it's a selector-mapping artifact, not a production download; delete it.

## Concurrency

`buildSharePointRosterDownloadHandler` keeps a module-level `rosterDownloadInFlight` flag. Concurrent invocations **across ids** return HTTP 409 with an actionable error — the dashboard renders this as a warning toast. Duo approval requires a phone in hand, so stacking browsers is both wasteful and confusing. Intentionally not keyed by `id` — downloading onboarding and a future separations roster in parallel would still compete for the same phone tap.

## Adding a new spreadsheet

1. Append a `SharePointDownloadSpec` to `SHAREPOINT_DOWNLOADS` in `registry.ts` — pick a URL-safe `id`, a short `label`, optional `description`, and a dedicated `envVar` name.
2. Add a commented example line to `.env.example` so operators know the var exists.
3. That's it. The dropdown auto-populates, the POST handler auto-routes by `id`, no backend or frontend edits needed.

If the registry grows past ~6 entries consider switching the dropdown to grouped menus (`DropdownMenuGroup` + a `group` field on the spec).

## Gotchas

- **Endpoints matter.** The dashboard fetches `GET /api/sharepoint-download/list` on mount and `POST /api/sharepoint-download/run` with `{ id }` on click. The pre-registry shape (POST with no body, reading `ONBOARDING_ROSTER_URL` unconditionally) was renamed on 2026-04-22. Grep before adding any reference.
- **Never call from the kernel.** If you find yourself writing `defineWorkflow({ name: "sharepoint-download", ... })`, stop — you're about to add this to the workflow dropdown and bake in tracker semantics that don't apply. If batch-style orchestration is genuinely needed later, define a new kernel workflow that *uses* `downloadSharePointFile` as a step, rather than promoting this one.
- **Missing env var is OK.** The dropdown still renders the item; it's just disabled with an "unset" hint and a tooltip pointing at the env var name. Only clicking a configured item launches a browser. Unknown `id` in the POST returns 404 with the list of valid ids — that can only happen if the frontend and backend registry go out of sync (stale bundle).

## Lessons Learned

- **2026-04-22: Not every "workflow" belongs in the kernel.** Initially lived at `src/workflows/emergency-contact/sharepoint-download.ts` because emergency-contact was the first consumer. Once the dashboard button was added (for every workflow, not just emergency-contact), it became clear the helper is a cross-cutting utility that just happens to be tall enough to deserve its own directory. Promoted to `src/workflows/sharepoint-download/` with the explicit non-kernel rule above so it stays out of the dropdown while enjoying co-location with real workflows.
- **2026-04-22: Dropdown + registry beats single-purpose button.** First cut was a single `Download onboarding spreadsheet` button hardcoded to `ONBOARDING_ROSTER_URL`. Folded into a `SHAREPOINT_DOWNLOADS` registry + `DropdownMenu` the same day — future spreadsheets (separations roster, kronos report links, etc.) are a one-liner in `registry.ts` + one env var. Handler split into `buildSharePointListHandler` (cheap, synchronous) feeding the dropdown on mount and `buildSharePointRosterDownloadHandler` (expensive, headed-browser) for the actual click. Concurrency lock stays id-agnostic because it's gating the Duo-tap resource, not a per-spreadsheet queue.
