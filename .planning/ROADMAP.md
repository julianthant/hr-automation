# Roadmap: UCPath HR Automation

## Overview

This roadmap delivers a CLI tool that automates the full employee onboarding pipeline: extract data from ACT CRM, check for duplicates in UCPath, create transactions, complete I9 forms, and track everything in a spreadsheet. Each phase delivers a verifiable capability that the next phase depends on.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Authentication and Project Foundation** - Establish authenticated browser sessions to both UCPath and ACT CRM through UCSD SSO with Duo MFA pause (completed 2026-03-13)
- [x] **Phase 01.1: Modular Codebase Restructure** (INSERTED) - Extract shared CRM and UCPath modules, establish multi-workflow architecture, organize tests (completed 2026-03-14)
- [x] **Phase 2: Data Extraction from ACT CRM** - Search, navigate, and extract validated employee data from the onboarding portal (completed 2026-03-14)
- [x] **Phase 3: UCPath Person Search and Transaction Setup** - Navigate UCPath, perform person duplicate check, set up transaction creation with dry-run safety (completed 2026-03-15)
- [ ] **Phase 3.1: CRM Additional Fields and Onboarding Tracker** (INSERTED) - Extract department number and recruitment number from CRM, create onboarding tracking spreadsheet
- [ ] **Phase 3.2: I9 Tracker Workflow** (INSERTED) - Authenticate to I9 Complete, fill employee details, select worksite by department number
- [ ] **Phase 4: UCPath Smart HR Transaction Creation** - Complete the UC_FULL_HIRE transaction flow in Smart HR Templates after person search passes
- [ ] **Phase 5: Batch Processing and CLI** - Process multiple employees from file input with per-employee error isolation, progress reporting, and structured logging

## Phase Details

### Phase 1: Authentication and Project Foundation
**Goal**: User can launch the tool, authenticate through UCSD SSO with Duo MFA, and reach both UCPath and ACT CRM in an authenticated browser session -- with project scaffolding, credential security, and PII-safe logging established from day one
**Depends on**: Nothing (first phase)
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05
**Success Criteria** (what must be TRUE):
  1. User can run a `test-login` CLI command that opens a browser, navigates to UCPath, and completes SSO login with a pause for Duo MFA approval
  2. After UCPath login succeeds, the same browser session can navigate to ACT CRM onboarding portal in an authenticated state (or complete a second auth flow if needed)
  3. If the user is already authenticated (valid session), re-running the tool skips the login flow and proceeds directly
  4. Credentials are loaded from a .env file, .gitignore blocks all secrets, and no PII appears in any log output
**Plans:** 2/2 plans complete

Plans:
- [x] 01-01-PLAN.md -- Project scaffolding, utilities (env validation, PII-safe logger), browser launch module, and auth type contracts
- [x] 01-02-PLAN.md -- Authentication flows (UCPath SSO + Duo MFA + ACT CRM) and test-login CLI command with session persistence

### Phase 01.1: Modular Codebase Restructure (INSERTED)

**Goal:** Reorganize the flat src/onboarding/ structure into shared src/crm/ and src/ucpath/ modules with workflow-specific src/workflows/onboarding/, and migrate co-located tests to a tests/ hierarchy -- establishing the multi-workflow architecture for future offboarding, pay change, and additional HR workflows
**Requirements**: RESTRUCTURE-01, RESTRUCTURE-02, RESTRUCTURE-03, RESTRUCTURE-04
**Depends on:** Phase 1
**Plans:** 2/2 plans complete

Plans:
- [x] 01.1-01-PLAN.md -- Create shared CRM module (search, navigate, extract, types) and onboarding workflow module (FIELD_MAP, schema, barrel)
- [x] 01.1-02-PLAN.md -- Rewire CLI imports, migrate tests to tests/unit/, config updates, and delete old directories

### Phase 2: Data Extraction from ACT CRM
**Goal**: User can provide an employee email and the tool extracts all required onboarding data from ACT CRM, validated against a strict schema before any downstream use
**Depends on**: Phase 1
**Requirements**: EXTR-01, EXTR-02, EXTR-03, EXTR-04, EXTR-05
**Success Criteria** (what must be TRUE):
  1. User can provide an employee email and the tool searches ACT CRM, selects the result row with the latest date, and navigates to the UCPath Entry Sheet
  2. The tool extracts position number, first name, last name, SSN, DOB, address, city, state, postal code, wage, and effective date from the entry sheet
  3. Extracted data passes Zod schema validation before being made available for downstream use
**Plans:** 2/2 plans complete

Plans:
- [x] 02-01-PLAN.md -- Zod schema with unit tests, extraction modules (search/navigate/extract) with best-guess selectors, and CLI extract command
- [x] 02-02-PLAN.md -- Live selector discovery against ACT CRM, iterative selector fixes, and user verification of end-to-end extraction

### Phase 3: UCPath Person Search and Transaction Setup
**Goal**: User can take validated employee data, authenticate to UCPath, and perform a person duplicate check -- with the full CRM extraction + person search pipeline working end-to-end
**Depends on**: Phase 2
**Requirements**: ENTR-01, ENTR-02, ENTR-03, ENTR-04, ENTR-05
**Success Criteria** (what must be TRUE):
  1. The tool navigates UCPath from homepage to HR Tasks Search/Match form
  2. Person search fills SSN, first name, last name, DOB and correctly detects duplicates vs new hires
  3. Dry-run mode previews actions without touching UCPath
  4. "Yes, this is my device" Duo confirmation handled automatically
  5. Browsers left open for reuse across employees
**Plans:** 3/3 plans complete

Plans:
- [x] 03-01-PLAN.md -- UCPath types (TransactionResult, TransactionError) and ActionPlan dry-run engine with unit tests
- [x] 03-02-PLAN.md -- UCPath navigation and transaction modules with best-guess selectors, onboarding entry workflow, and create-transaction CLI command
- [x] 03-03-PLAN.md -- Live PeopleSoft selector discovery, person search implementation, and end-to-end verification

### Phase 3.1: CRM Additional Fields and Onboarding Tracker (INSERTED)

**Goal:** Extract department number (from parentheses in department text) and recruitment number from the CRM record page (before navigating to UCPath Entry Sheet), and create an onboarding tracking spreadsheet that records all employee data, rehire status, and workflow progress
**Depends on:** Phase 3
**Requirements**: TRACK-01, TRACK-02, TRACK-03
**Success Criteria** (what must be TRUE):
  1. Department number extracted from CRM department text field (e.g., "(000412)" → "000412")
  2. Recruitment number extracted from CRM record
  3. Onboarding spreadsheet created/updated with: employee name, SSN (masked), DOB, department #, recruitment #, rehire status (X if person exists in UCPath), effective date, workflow step status
  4. Spreadsheet is reused across multiple employees in the same session
**Plans:** 2 plans

Plans:
- [ ] 03.1-01-PLAN.md -- Install ExcelJS, extend EmployeeData schema with dept# and recruitment#, create tracker module with unit tests
- [ ] 03.1-02-PLAN.md -- CRM record page extraction, tracker CLI integration, and live selector discovery

### Phase 3.2: I9 Tracker Workflow (INSERTED)

**Goal:** Authenticate to I9 Complete (stse.i9complete.com), create a new I9 employee record with data extracted from CRM, and select the worksite using the department number
**Depends on:** Phase 3.1 (needs department number)
**Requirements**: I9-01, I9-02, I9-03
**Success Criteria** (what must be TRUE):
  1. Tool authenticates to I9 Complete (separate email/password auth, not SSO)
  2. Dismisses notification popup, clicks "Create New I9 Employee"
  3. Fills first name, middle name, last name, SSN, DOB, email from CRM data
  4. Selects worksite from dropdown using department number
  5. Clicks Save and Continue
**Plans**: TBD

### Phase 4: UCPath Smart HR Transaction Creation
**Goal**: After person search confirms no duplicate, navigate to Smart HR Templates and create the UC_FULL_HIRE transaction with template selection, effective date entry, and transaction confirmation
**Depends on**: Phase 3 (person search must pass)
**Requirements**: ENTR-01, ENTR-02, ENTR-03, ENTR-04
**Success Criteria** (what must be TRUE):
  1. Tool navigates from person search to Smart HR Templates → Smart HR Transactions
  2. Selects UC_FULL_HIRE template, enters effective date, clicks Create Transaction
  3. Confirms transaction created successfully or reports specific failure
  4. All PeopleSoft selectors verified against live UCPath
**Plans**: TBD

### Phase 5: Batch Processing and CLI
**Goal**: User can provide a file of employee emails and the tool processes them sequentially with per-employee error isolation, progress reporting, and a structured audit log -- making the tool ready for daily HR use
**Depends on**: Phase 4
**Requirements**: BTCH-01, BTCH-02, BTCH-03, BTCH-04
**Success Criteria** (what must be TRUE):
  1. User can provide a CSV or text file of employee emails and the tool processes each one through the full pipeline (extract, person search, I9, transaction) sequentially
  2. User can run the tool from the command line with flags for input file and dry-run mode
  3. A failed employee does not abort the batch -- the tool isolates the error, logs it, and continues to the next employee
  4. User sees a progress indicator during processing and a final summary of successes and failures
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 01.1 → 2 → 3 → 3.1 → 3.2 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Authentication and Project Foundation | 2/2 | Complete | 2026-03-13 |
| 01.1. Modular Codebase Restructure | 2/2 | Complete | 2026-03-14 |
| 2. Data Extraction from ACT CRM | 2/2 | Complete | 2026-03-14 |
| 3. UCPath Person Search | 3/3 | Complete | 2026-03-15 |
| 3.1. CRM Additional Fields + Tracker | 0/2 | Planned | - |
| 3.2. I9 Tracker Workflow | 0/0 | Not started | - |
| 4. UCPath Smart HR Transaction | 0/0 | Not started | - |
| 5. Batch Processing and CLI | 0/0 | Not started | - |
