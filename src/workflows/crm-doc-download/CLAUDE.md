# CRM Doc Download Workflow

Downloads **ACT CRM iDocs PDFs** for an onboarding record, then **packages each run into a zip** under `~/Documents/onboarding/`: search the CRM onboarding list, open the latest row, download configured documents, resolve the person's name, then archive. Invoked from the dashboard input-run surface (EIDs **or emails**). Onboarding does **not** reach this workflow — it downloads iDocs in-process (`folderSubjectFromLegalLived` + `buildCrmDocumentDownloadPath` + `downloadCrmIdocsDocuments`) using the same roster Legal vs Lived folder names; the lineage fields stay in the schema for any future delegating parent.

**Kernel-based** — `crmDocDownloadWorkflow` in `workflow.ts`; CRM-only auth; pool batch mode.

## Output (zip, names, location)

- **Location:** `PATHS.onboardingDocsDir` = `data/onboarding/` by default (Settings → Paths overridable; moved under repo `data/` 2026-07-16).
- **Folder name:** `Last, First (LivedName) MiddleInitial. EID` (`buildCrmDocumentFolderName` in `src/systems/crm/idocs-download.ts`, subject from `folderSubjectFromLegalLived` in `src/systems/crm/document-folder-subject.ts`). The lived-first-name parenthetical is included **only when it differs from the legal first name**; the middle initial (with a period) is included only when a middle name exists. **"EID" is a literal trailing token**, not the numeric employee id.
- **Name source:** Legal Name vs Lived Name on the **onboarding roster** (Email / Legal Name / Lived Name columns), not CRM. Dashboard email/EID runs look the person up by email (`src/workflows/crm-doc-download/folder-names.ts`); explicit `firstName`/`lastName`/`livedName` on the input still win. CRM First Name is often the lived name, so naming from the UCPath Entry Sheet produced folders like `Breuer, Eli EID` instead of `Breuer, Elijah (Eli) EID`. A miss (no roster file, email not on the roster) **throws** rather than falling back to CRM. Download the Onboarding Roster from the dashboard SharePoint menu if none is present.
- **Per-document filenames:** each saved PDF is `Doc<N>-<name>.pdf` where `<name>` is the CRM Content-Disposition filename, or — when the iDocs server sends none (the usual case) — a **position-based default** from `CRM_DOC_DEFAULT_NAMES` / `defaultCrmDocumentName` (`src/systems/crm/idocs-download.ts`): doc 1 (index 0) → `Signed Offer Letter`, doc 3 (index 2) → `EE Data Gathering Form`; other indices fall back to `document-N`. The `Doc<N>-` prefix is kept (the already-downloaded skip check matches `^Doc<N>-.+\.pdf$`).
- **Zip granularity:** **one combined zip per run.** Every person of a multi-input run shares `parentRunId`, so all pool workers append into the same `Onboarding Docs <YYYY-MM-DD> <batch8>.zip` under a cross-process lock (`withFileLock` + `zipFolderInto`, `src/utils/zip.ts`); a standalone run gets its own `<folderName>.zip`. The raw unzipped folder is **deleted** once it is in the archive (`resolveArchivePath` decides the path; it's pure + unit-tested).

## Selector intelligence

This workflow touches **crm** only.

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"`.
- Per-system lessons: [`src/systems/crm/LESSONS.md`](../../systems/crm/LESSONS.md)
- Catalog: [`src/systems/crm/SELECTORS.md`](../../systems/crm/SELECTORS.md)

## Step pipeline

1. **`search-record`** — `searchCrmOnboardingRecords` with the resolved query (email or emplId), then `selectLatestResult` (retries wired via `ctx.retry`).
2. **`download`** — `downloadCrmIdocsDocuments` into a temp folder (or straight into the known final folder when the caller supplied a name/`folderPath`). The temp split exists because step 3 navigates away from the record page, which the PDF.js iframe download depends on.
3. **`archive`** — resolve the person's name (input override → onboarding-roster Legal vs Lived; EID-only matches the record's UCSD/personal email to the roster), rename the temp folder to `Last, First (LivedName) Middle EID` when it was not known up front, zip it into the run's combined archive under a lock, then delete the raw folder. Updates `firstName`/`lastName`/`middleName`/`livedName` + `pdfDownload` / `pdfFolder` (now the zip path) on the tracker row.

## Dashboard Input Run

```bash
InputRunPanel → /api/enqueue
  body: { workflow: "crm-doc-download", inputs: [{ emplId } | { email }] }
```

The comma-separated input box accepts **EIDs and emails interchangeably** — `parseCrmDocDownloadInputs` (`src/dashboard/lib/input-run-registry.ts`) discriminates each token (numeric 5+ digits → `emplId`, valid email → `email`) and rejects anything else. This mirrors the schema/`inputSubject`, which already keyed on whichever field is populated.

Daemon spawn/enqueue matches other dashboard input-run workflows (`src/core/daemon/enqueue-dispatch.ts` + `cli-daemon.ts` registration).

## Delegation lineage

The schema keeps `parentRunId`, `parentSubject`, and `taskGroupId` for a future delegating parent (none today — onboarding is in-process). `parentRunId` doubles as the **combined-zip grouping key**: co-batched/co-delegated runs share it, so they land in one archive.

## Lessons Learned

- **2026-09-16: Folder names come from the onboarding roster, not CRM.** CRM First Name is the lived/preferred name in practice, so an email/EID dashboard run that extracted the UCPath Entry Sheet produced `Breuer, Eli EID` instead of `Breuer, Elijah (Eli) EID`. Look up Email → Legal Name / Lived Name; omit `(Lived)` when the first names match. Throw if the roster is missing or the email is not on it — never degrade to CRM or `<query> EID`.
- **2026-06-18: One combined zip per run, output under `data/onboarding/`.** Output moved off `~/Downloads/`; a run's folders are packaged into **one** `Onboarding Docs <date> <batch8>.zip` (raw folders deleted). Combined-zip-in-`pool`-mode works without a batch-completion hook: each worker APPENDS its folder under a `withFileLock` lock keyed by a deterministic `resolveArchivePath(parentRunId)`, so the archive is complete when the last worker finishes — no "am I last?" race. Standalone (no `parentRunId`) → its own `<folderName>.zip`.
- **2026-06-18: Lived-name CRM labels are UNVERIFIED (and unused for folder naming).** `extractCrmPersonName`'s First/Last/Middle labels mirror onboarding's live-verified Entry Sheet labels, but the lived-name labels (`Lived Name` / `Lived First Name` / `Preferred Name` / `Preferred First Name`) are best-effort guesses. Folder naming no longer depends on them (roster Legal vs Lived is the source). Verify against a real CRM record before using those labels for anything else, then bump the `// verified` dates.
- **2026-05-25: Dashboard input run is the public start path.** `npm run crm-doc-download` is retired; typed starts belong in `InputRunPanel` and `/api/enqueue`.
