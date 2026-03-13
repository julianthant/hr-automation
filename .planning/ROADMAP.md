# Roadmap: UCPath HR Automation

## Overview

This roadmap delivers a CLI tool that automates employee onboarding data transfer from ACT CRM to UCPath. The phases follow the strict dependency chain of the automation pipeline: authenticate into both systems, extract employee data from ACT CRM, enter that data into UCPath, then scale to batch processing. Each phase delivers a verifiable capability that the next phase depends on.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Authentication and Project Foundation** - Establish authenticated browser sessions to both UCPath and ACT CRM through UCSD SSO with Duo MFA pause
- [ ] **Phase 2: Data Extraction from ACT CRM** - Search, navigate, and extract validated employee data from the onboarding portal
- [ ] **Phase 3: UCPath Transaction Entry** - Navigate UCPath Smart HR Transactions and create UC_FULL_HIRE transactions using extracted data, with dry-run safety
- [ ] **Phase 4: Batch Processing and CLI** - Process multiple employees from file input with per-employee error isolation, progress reporting, and structured logging

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
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md -- Project scaffolding, utilities (env validation, PII-safe logger), browser launch module, and auth type contracts
- [ ] 01-02-PLAN.md -- Authentication flows (UCPath SSO + Duo MFA + ACT CRM) and test-login CLI command with session persistence

### Phase 2: Data Extraction from ACT CRM
**Goal**: User can provide an employee email and the tool extracts all required onboarding data from ACT CRM, validated against a strict schema before any downstream use
**Depends on**: Phase 1
**Requirements**: EXTR-01, EXTR-02, EXTR-03, EXTR-04, EXTR-05
**Success Criteria** (what must be TRUE):
  1. User can provide an employee email and the tool searches ACT CRM, selects the result row with the latest date, and navigates to the UCPath Entry Sheet
  2. The tool extracts position number, first name, last name, SSN, address, city, state, postal code, wage, and effective date from the entry sheet
  3. Extracted data passes Zod schema validation before being made available for downstream use -- incomplete or malformed data is rejected with a clear error message identifying the failing fields
**Plans**: TBD

Plans:
- [ ] 02-01: TBD
- [ ] 02-02: TBD

### Phase 3: UCPath Transaction Entry
**Goal**: User can take validated employee data and create a UC_FULL_HIRE transaction in UCPath Smart HR Transactions -- with a dry-run mode that previews actions without submitting, given the no-undo nature of UCPath transactions
**Depends on**: Phase 2
**Requirements**: ENTR-01, ENTR-02, ENTR-03, ENTR-04, ENTR-05
**Success Criteria** (what must be TRUE):
  1. The tool navigates UCPath from the homepage through HR Tasks to Smart HR Transactions, selects the UC_FULL_HIRE template, enters the effective date, and clicks Create Transaction
  2. User can run in dry-run mode that displays extracted data and every intended UCPath action without actually submitting -- no UCPath form is modified in dry-run
  3. After a real (non-dry-run) transaction creation, the tool confirms the transaction was created successfully or reports the specific failure
**Plans**: TBD

Plans:
- [ ] 03-01: TBD
- [ ] 03-02: TBD

### Phase 4: Batch Processing and CLI
**Goal**: User can provide a file of employee emails and the tool processes them sequentially with per-employee error isolation, progress reporting, and a structured audit log -- making the tool ready for daily HR use
**Depends on**: Phase 3
**Requirements**: BTCH-01, BTCH-02, BTCH-03, BTCH-04
**Success Criteria** (what must be TRUE):
  1. User can provide a CSV or text file of employee emails and the tool processes each one through the full pipeline (auth, extract, enter) sequentially
  2. User can run the tool from the command line with flags for input file and dry-run mode
  3. A failed employee does not abort the batch -- the tool isolates the error, logs it, and continues to the next employee
  4. User sees a progress indicator during processing (e.g., "3/10 employees processed") and a final summary of successes and failures
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Authentication and Project Foundation | 0/2 | Planned | - |
| 2. Data Extraction from ACT CRM | 0/0 | Not started | - |
| 3. UCPath Transaction Entry | 0/0 | Not started | - |
| 4. Batch Processing and CLI | 0/0 | Not started | - |
