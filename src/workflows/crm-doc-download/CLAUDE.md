# CRM Doc Download Workflow

Downloads **ACT CRM iDocs PDFs** for an onboarding record: search the CRM onboarding list, open the latest row, then download configured documents to a folder on disk. Invoked from the dashboard input-run surface (EIDs) or **as a delegation target** from **onboarding** (and any other workflow that enqueues `crm-doc-download` with parent lineage fields).

**Kernel-based** — `crmDocDownloadWorkflow` in `workflow.ts`; CRM-only auth; pool batch mode.

## Selector intelligence

This workflow touches **crm** only.

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"`.
- Per-system lessons: [`src/systems/crm/LESSONS.md`](../../systems/crm/LESSONS.md)
- Catalog: [`src/systems/crm/SELECTORS.md`](../../systems/crm/SELECTORS.md)

## Step pipeline

1. **`search-record`** — `searchCrmOnboardingRecords` with the resolved query (email or emplId), then `selectLatestResult` (retries wired via `ctx.retry`).
2. **`download`** — `downloadCrmIdocsDocuments` into `resolveCrmDocDownloadFolder` (default under `~/Downloads/onboarding/` when names are present; see `workflow.ts`). Updates `pdfDownload` / `pdfFolder` on the tracker row.

## Dashboard Input Run

```bash
InputRunPanel → /api/enqueue
  body: { workflow: "crm-doc-download", inputs: [{ emplId } | { email }] }
```

The comma-separated input box accepts **EIDs and emails interchangeably** — `parseCrmDocDownloadInputs` (`src/dashboard/lib/input-run-registry.ts`) discriminates each token (numeric 5+ digits → `emplId`, valid email → `email`) and rejects anything else. This mirrors the schema/`inputSubject`, which already keyed on whichever field is populated.

Daemon spawn/enqueue matches other dashboard input-run workflows (`src/core/daemon/enqueue-dispatch.ts` + `cli-daemon.ts` registration).

## Delegation (onboarding)

When **onboarding** (or another parent) runs this workflow in-process or via queue, inputs may carry `parentRunId`, `parentSubject`, and `taskGroupId` so the dashboard and logs show lineage.

## Lessons Learned

- **2026-05-25: Dashboard input run is the public start path.** `npm run crm-doc-download` is retired; typed starts belong in `InputRunPanel` and `/api/enqueue`.
- **2026-05-26: Parent lineage fields are explicit.** Delegated CRM document downloads use `parentRunId`, `parentSubject`, and `taskGroupId`; the old source-workflow marker is not part of the schema or tracker detail fields.
