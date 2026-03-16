# Parallel Onboarding with Enhanced Tracking

## Overview

Add parallel processing to the onboarding workflow, enhance the Excel tracker with full employee data and stage-level tracking, add no-SSN handling, and add CRM document download as a post-extraction step.

## 1. CLI & Input

### Batch File

Default location: `src/workflows/onboarding/batch.yaml`

```yaml
- email1@ucsd.edu
- email2@ucsd.edu
- email3@ucsd.edu
```

Simple list of emails. No file path flag needed — the batch file is always at the default location.

### CLI Interface

```bash
# Single employee (existing behavior, unchanged)
npm run start-onboarding email@ucsd.edu

# Batch mode with parallel workers
npm run start-onboarding --parallel 3

# Batch + dry run
npm run start-onboarding --parallel 3 --dry-run
```

- `<email>` argument changes from required to optional: `[email]`
- Validation: exactly one of `email` arg or `--parallel N` must be provided. Error if both or neither.
- `--parallel` requires a numeric value (Commander: `--parallel <N>`). Error if no number given.
- `--parallel N` reads from the default batch file and spawns N concurrent workers
- Single email arg still works as before (single worker, no batch file)
- `--dry-run` works with both modes. In batch dry-run, workers only launch CRM browsers (no UCPath browser needed).
- Batch file validation: fail fast with clear error if `batch.yaml` is missing, empty, or contains invalid entries

## 2. Parallel Processing Architecture

### Worker Pool

- Main process reads the batch file and creates a FIFO queue of emails
- Spawns N workers based on `--parallel` count
- Each worker gets its own independent browser instances (CRM browser + UCPath browser)
- Workers pull the next email from the queue when they finish one
- Uneven processing times are handled naturally (rehires finish fast, new hires take longer)

### Error Isolation

- If a worker hits an error on one employee:
  - Logs the failure with worker prefix
  - Updates the tracker row with error status and error message
  - Moves to the next email in the queue
  - Does NOT crash the worker or the pool
- All browsers are left open at the end for user observation

### Browser Lifecycle

- Each worker launches its own CRM and UCPath browser pair once at startup
- Workers **reuse** their browsers across multiple employees — they do NOT launch fresh browsers per employee
- However, workers **re-authenticate** for each employee (per project principle: always login fresh)
- With `--parallel 5`, up to 10 browsers are open simultaneously (5 CRM + 5 UCPath)
- All browsers remain open after completion for user observation

### Console Logging

All log output prefixed with worker number for traceability:
```
[Worker 1] Extracting CRM data for email@ucsd.edu...
[Worker 2] Person search complete — no match found
[Worker 1] Transaction step 3/14: Selecting template...
```

### Concurrency Control

- Excel file writes use an async mutex (e.g., `async-mutex` package)
- A single `Mutex` instance is created in `parallel.ts` and passed into each worker's context
- `updateTracker` (or a wrapper in `parallel.ts`) acquires/releases the lock internally — callers never manage the lock directly
- Lock granularity: per-file (one lock for the entire tracker file)

### No Core Module Changes

The existing modules are untouched:
- `src/auth/` — login flows
- `src/crm/` — navigation, search, extraction
- `src/ucpath/` — navigation, person search, transactions
- `src/browser/launch.ts` — browser launch

Parallelism is purely orchestration on top of these modules.

## 3. Excel Tracker Overhaul

### File Location

Moved from project root to: `src/workflows/onboarding/onboarding-tracker.xlsx`

This places the tracker alongside the workflow it tracks, per the user's request that trackers live in their specific workflow folders. Since this project uses `tsx` to run source files directly (no build step/bundler), there is no risk of the data file being processed or duplicated.

Update `src/config.ts` TRACKER_PATH accordingly.

### Daily Worksheets

- Each day gets its own worksheet tab named `YYYY-MM-DD` (e.g., `2026-03-16`)
- If a tab for today already exists, new rows are appended to it
- Previous days' tabs are preserved in the same file

### Columns

All extracted employee data fields plus stage tracking:

| Column | Key | Source | Description |
|--------|-----|--------|-------------|
| First Name | firstName | extracted | |
| Middle Name | middleName | extracted | |
| Last Name | lastName | extracted | |
| SSN | ssn | extracted | Full SSN, not masked |
| DOB | dob | extracted | |
| Phone | phone | extracted | |
| Email | email | extracted | |
| Address | address | extracted | |
| City | city | extracted | |
| State | state | extracted | |
| Postal Code | postalCode | extracted | |
| Dept # | departmentNumber | extracted | |
| Recruitment # | recruitmentNumber | extracted | |
| Position # | positionNumber | extracted | |
| Wage | wage | extracted | |
| Effective Date | effectiveDate | extracted | |
| Appointment | appointment | extracted | |
| CRM Extraction | crmExtraction | stage | Done / Failed |
| Person Search | personSearch | stage | Done / Failed |
| Rehire | rehire | stage | "X" if rehire, blank otherwise |
| I9 Record | i9Record | stage | Done / Failed / Skipped |
| Transaction | transaction | stage | Done / Failed |
| PDF Download | pdfDownload | stage | Done / Failed |
| I9 Profile ID | i9ProfileId | value | Profile ID string |
| Status | status | overall | Done / Failed / Dry Run |
| Error | error | error | Error message if any stage failed |
| Timestamp | timestamp | auto | ISO timestamp when row was written |

Stage status values: `Done`, `Failed`, `Skipped`, `Dry Run`, or blank if not yet reached.

### TrackerRow and Builder Updates

- `src/tracker/columns.ts` — updated with new column definitions
- `src/tracker/spreadsheet.ts` — updated to use daily worksheet tabs instead of a single "Onboarding Tracker" sheet, SSN stored unmasked
- `src/tracker/builder.ts` — updated to include all extracted fields and new stage columns

## 4. No-SSN Handling

### Detection

If `data.ssn` is undefined, null, or empty string after extraction.

### SSN Schema Change

The Zod schema for `ssn` must accept both `undefined` and empty string `""`. Change from:
```typescript
ssn: z.string().regex(...).optional()
```
To:
```typescript
ssn: z.string().regex(...).optional().or(z.literal(""))
```

### UCPath Form Behavior

- SSN field is left blank (skip the fill step in `enter.ts`; also make `ssn` optional in `PersonalDataInput` interface in `src/ucpath/transaction.ts` and add a conditional guard around the SSN fill call)
- Both comment fields use a **replacement** comment (not appended after the standard comment). When SSN is missing, the full comment text becomes:

```
New Dining Student Hire Effective {effectiveDate}. Job number #{recruitmentNumber}. International Student. NO SSN.
```

When SSN is present, the standard comment text is used as before:
```
New Dining Student Hire Effective {effectiveDate}. Job number #{recruitmentNumber}.
```

The `buildCommentsText()` function in `enter.ts` gains a parameter to control this.

### Tracker

SSN column shows blank for these employees.

## 5. CRM Document Download

### Timing

Immediately after CRM data extraction, while still on the main CRM record page (before navigating to UCPath Entry Sheet). This avoids an extra navigation back to the CRM page after UCPath submission.

### Folder Structure

```
{Downloads}/onboarding/{Last Name, First Name Middle Name EID}/
```

- `{Downloads}` — resolved cross-platform using platform-appropriate paths:
  - Windows: `C:\Users\{user}\Downloads`
  - macOS: `/Users/{user}/Downloads`
  - Linux: `/home/{user}/Downloads`
  - Uses Node.js `os.homedir()` + `/Downloads`
- `onboarding/` — created if it doesn't exist
- Employee folder — e.g., `Smith, John Michael EID` (literal "EID" as placeholder for user to paste in later)

### Download Process

1. On the main CRM record page, locate the document selector control
2. Select Document 1
3. Wait for the PDF viewer to load
4. Scroll the embedded PDF viewer to the end (ensures all pages are rendered/available)
5. Download the PDF to the employee's folder
6. Select Document 3
7. Scroll to end, download to same folder
8. Update tracker with PDF Download stage status

### Selector Discovery (Required Investigation Spike)

Before writing download code, use playwright-cli to:
- Identify the document selector element and its options
- Identify the PDF viewer iframe/element
- Test scrolling behavior to ensure all pages load
- Identify the download mechanism (button, right-click save, or programmatic)

The likely approach is intercepting the PDF URL from network requests and downloading via `fetch`/`page.request`, or triggering a download button if the viewer provides one. The exact mechanism will be determined during the playwright-cli investigation and may require adjustments to the implementation plan.

## 6. Updated Workflow Sequence

For each employee, the workflow becomes:

```
1. Reuse worker's CRM browser (or launch if first employee)
2. Login to ACT CRM (fresh auth each employee)
3. Search by email
4. Select latest result
5. Extract record page fields (dept#, recruitment#)
6. Download Documents 1 and 3 (NEW)
   - Create folder: {Downloads}/onboarding/{Last, First Middle EID}/
   - Download Doc 1 (scroll to end first)
   - Download Doc 3 (scroll to end first)
7. Navigate to UCPath Entry Sheet
8. Extract all employee data fields
9. Validate against schema
10. [If dry-run: preview plan, update tracker, done]
11. Reuse worker's UCPath browser (or launch if first employee)
12. Login to UCPath (fresh auth each employee)
13. Person search
14. [If rehire: update tracker, move to next]
15. I9 record creation (currently mocked as "MOCK_I9" — still mocked in this phase)
16. Build transaction plan (with no-SSN comment logic if applicable)
17. Execute transaction (14 UCPath steps)
18. Update tracker with final status
19. Pull next email from queue (if batch mode)
```

## 7. Files to Create/Modify

### New Files
- `src/workflows/onboarding/batch.yaml` — default batch input file (empty template)
- `src/workflows/onboarding/parallel.ts` — worker pool orchestration, queue management
- `src/workflows/onboarding/download.ts` — CRM document download logic

### Modified Files
- `src/cli.ts` — `[email]` optional arg, `--parallel <N>` option, batch mode routing
- `src/tracker/columns.ts` — expanded column definitions
- `src/tracker/spreadsheet.ts` — daily worksheet tabs, unmasked SSN, mutex-aware wrapper
- `src/tracker/builder.ts` — all extracted fields, new stage columns
- `src/workflows/onboarding/enter.ts` — no-SSN comment logic in `buildCommentsText()`
- `src/workflows/onboarding/schema.ts` — SSN accepts `undefined` or `""` (empty string)
- `src/workflows/onboarding/workflow.ts` — integrate PDF download step, accept reusable browser instances
- `src/workflows/onboarding/config.ts` — add download-related constants
- `src/ucpath/transaction.ts` — make `ssn` optional in `PersonalDataInput`, conditional guard on SSN fill
- `src/config.ts` — update TRACKER_PATH to new location
- `CLAUDE.md` — update commands and architecture docs
