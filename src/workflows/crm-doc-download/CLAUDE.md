# CRM Doc Download Workflow

Downloads **ACT CRM iDocs PDFs** for an onboarding record: search the CRM onboarding list, open the latest row, then download configured documents to a folder on disk. Invoked standalone via `npm run crm-doc-download` (positional emails → daemon queue) or **as a delegation target** from **onboarding** (and any other workflow that enqueues `crm-doc-download` with `originWorkflow` / parent lineage fields).

**Kernel-based** — `crmDocDownloadWorkflow` in `workflow.ts`; CRM-only auth; pool batch mode.

## Selector intelligence

This workflow touches **crm** only.

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"`.
- Per-system lessons: [`src/systems/crm/LESSONS.md`](../../systems/crm/LESSONS.md)
- Catalog: [`src/systems/crm/SELECTORS.md`](../../systems/crm/SELECTORS.md)

## Files

- `schema.ts` — `CrmDocDownloadInputSchema`: `email` or `emplId` required; optional `firstName`/`lastName`/`middleName` for download path, `folderPath` override, `docIndices`, delegation fields (`originWorkflow`, `parentRunId`, …).
- `workflow.ts` — `defineWorkflow`, `runCrmDocDownload`, `runCrmDocDownloadCli`.
- `index.ts` — Barrel exports.

## Kernel config (`crmDocDownloadWorkflow`)

| Field | Value |
|-------|-------|
| `systems` | `[crm]` |
| `steps` | `["search-record", "download"]` |
| `schema` | `CrmDocDownloadInputSchema` |
| `authSteps` | `true` — visible pipeline includes `auth:crm` before business steps |
| `authChain` | `"sequential"` |
| `batch` | `{ mode: "pool", poolSize: 4, preEmitPending: true }` |
| `detailFields` | `emplId`, `email`, `pdfDownload`, `pdfFolder`, `originWorkflow` |

## Step pipeline

1. **`search-record`** — `searchCrmOnboardingRecords` with the resolved query (email or emplId), then `selectLatestResult` (retries wired via `ctx.retry`).
2. **`download`** — `downloadCrmIdocsDocuments` into `resolveCrmDocDownloadFolder` (default under `~/Downloads/onboarding/` when names are present; see `workflow.ts`). Updates `pdfDownload` / `pdfFolder` on the tracker row.

## CLI

```bash
npm run crm-doc-download <email> [email...] [--new] [--parallel N]
npm run crm-doc-download:stop
```

Daemon spawn/enqueue matches other converted workflows (`src/core/cli-adapter.ts` + `cli-daemon.ts` registration).

## Inputs and outputs

- **Inputs:** At minimum **`email` or `emplId`**. Optional path and doc index controls live on `CrmDocDownloadInput` (see `schema.ts`).
- **Outputs:** Tracker fields include download counts, folder path, `taskRole` (`utility` when `originWorkflow` is set, else `root`), plus delegation metadata when enqueued by a parent workflow.

## Delegation (onboarding)

When **onboarding** (or another parent) runs this workflow in-process or via queue, inputs may carry `originWorkflow`, `parentRunId`, `parentSubject`, `taskGroupId` so the dashboard and logs show lineage. The handler stamps `taskRole: "utility"` when `originWorkflow` is present.

## Operator notes

- **`onPreEmitFailed`** on the CLI adapter writes a failed tracker row if daemon spawn/enqueue dies before work starts (see `workflow.ts`).
- For CRM system quirks (frames, search behavior), read `src/systems/crm/CLAUDE.md` before changing steps.

## Lessons Learned

*(None yet.)*
