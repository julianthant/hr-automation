# Onboarding Workflow

Automates full UC employee hiring: extracts data from ACT CRM, validates with Zod, searches UCPath for duplicates, creates Smart HR transactions, and tracks status in Excel.

## Files

- `schema.ts` — Zod `EmployeeData` schema (names, SSN, address, wage, appointment, dates)
- `extract.ts` — CRM field extraction from UCPath Entry Sheet using `FIELD_MAP` label mapping; also extracts dept/recruitment numbers from record page
- `enter.ts` — Builds `ActionPlan` for the 14-step Smart HR transaction (personal data, job data, comments, save/submit)
- `config.ts` — Constants: `UC_FULL_HIRE` template, `UCHRLY` comp rate code, `06/30/2026` end date
- `tracker.ts` — Writes to `onboarding-tracker.xlsx` with status checkpoint columns (CRM, person search, rehire, I9, transaction, PDF)
- `download.ts` — Stub for CRM document PDF downloads (TODO — needs selector discovery via playwright-cli)
- `parallel.ts` — Batch mode: loads `batch.yaml` email list, launches N workers with separate CRM/UCPath browsers, mutex-locked tracker writes
- `workflow.ts` — Main orchestration: auth CRM + UCPath, extract, validate, duplicate check, execute transaction, update tracker
- `index.ts` — Barrel exports

## Data Flow

```
batch.yaml / CLI email
  → CRM search (by email) → select latest "Offer Sent On"
  → Extract fields from UCPath Entry Sheet (FIELD_MAP)
  → Extract dept # and recruitment # from record page
  → Validate against EmployeeData Zod schema
  → UCPath Person Search (duplicate/rehire check)
  → ActionPlan: Smart HR Transaction (UC_FULL_HIRE)
  → Tracker update (onboarding-tracker.xlsx)
```

## Gotchas

- SSN/DOB are optional (international students) but wage requires `$` prefix
- Appointment field: extracts just the number from "Casual/Restricted 5" → `"5"`
- I9 profile ID is hardcoded to `"MOCK_I9"` (awaiting real implementation)
- `download.ts` is a placeholder — no Playwright selectors yet
- Department number parsed from parenthesized text: `"Computer Science (000412)"` → `"000412"`
- In single mode, errors cause `process.exit(1)`; in parallel mode, errors throw to caller
- Job end date hardcoded to `06/30/2026` in config
- Dual browser setup: CRM page + UCPath page (each with separate auth)
- Parallel mode uses mutex for tracker writes to prevent Excel file corruption
