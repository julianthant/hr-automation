# Requirements: UCPath HR Automation

**Defined:** 2026-03-13
**Core Value:** Reliably transfer employee onboarding data from ACT CRM portal into UCPath's UC_FULL_HIRE template without manual copy-pasting

## v1 Requirements

### Authentication

- [x] **AUTH-01**: User can launch browser and navigate to UCPath login page (ucpath.ucsd.edu)
- [x] **AUTH-02**: Automation clicks "Log in to UCPath", selects UC San Diego, and enters stored credentials
- [x] **AUTH-03**: Automation pauses at Duo MFA screen and waits for user to approve on phone, then detects successful login
- [x] **AUTH-04**: Automation authenticates to ACT CRM onboarding portal (act-crm.my.site.com) via same SSO session or separate auth flow (if separate login required, select "Active Directory" from dropdown before entering credentials)
- [x] **AUTH-05**: Automation detects existing valid session and skips login when already authenticated

### Data Extraction

- [ ] **EXTR-01**: Automation searches ACT CRM onboarding portal by employee email address
- [ ] **EXTR-02**: Automation selects the search result row with the latest date
- [ ] **EXTR-03**: Automation navigates to employee profile and clicks UCPath Entry Sheet
- [ ] **EXTR-04**: Automation extracts position number, first name, last name, SSN, address, city, state, postal code, wage, and effective date from UCPath Entry Sheet
- [ ] **EXTR-05**: Extracted data passes Zod schema validation before proceeding (rejects incomplete or malformed data)

### UCPath Entry

- [ ] **ENTR-01**: Automation navigates UCPath to Smart HR Transactions (PeopleSoft Homepage -> HR Tasks -> Smart HR Templates dropdown -> Smart HR Transactions)
- [ ] **ENTR-02**: Automation selects template UC_FULL_HIRE in the template selector
- [ ] **ENTR-03**: Automation enters the effective date from extracted data into the date field
- [ ] **ENTR-04**: Automation clicks Create Transaction
- [ ] **ENTR-05**: User can run in dry-run mode that shows extracted data and intended actions without submitting to UCPath

### Batch & CLI

- [ ] **BTCH-01**: User can provide a list of employee emails via file (CSV/text) as CLI input
- [ ] **BTCH-02**: User can run the tool from command line with flags for input file, dry-run mode, etc.
- [ ] **BTCH-03**: Each employee processed is logged with success/failure status and any error details
- [ ] **BTCH-04**: User sees progress indicator during batch processing (e.g., "3/10 employees processed")

## v2 Requirements

### Full Form Entry

- **FORM-01**: Automation fills in all employee data fields (names, SSN, address, wage) in the UC_FULL_HIRE form after Create Transaction
- **FORM-02**: Automation performs readback verification -- confirms entered values match extracted data

### Reliability

- **RELY-01**: User can resume interrupted batch from where it left off
- **RELY-02**: Automation retries failed employees with configurable retry count

### Additional Workflows

- **WKFL-01**: Support additional Smart HR templates beyond UC_FULL_HIRE
- **WKFL-02**: Support employee offboarding workflow
- **WKFL-03**: Support pay rate change workflow

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automated Duo MFA bypass | Security policy violation; MFA requires human confirmation |
| Web frontend / dashboard | CLI-first for v1; web UI is future enhancement |
| Headless browser mode | Duo MFA requires visible browser for user to approve |
| Direct API integration | No API access available for either system |
| PII data persistence / database | Security risk; data should flow through, not be stored |
| Parallel browser sessions | Complexity risk; sequential processing is safer for v1 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | Complete |
| AUTH-02 | Phase 1 | Complete |
| AUTH-03 | Phase 1 | Complete |
| AUTH-04 | Phase 1 | Complete |
| AUTH-05 | Phase 1 | Complete |
| EXTR-01 | Phase 2 | Pending |
| EXTR-02 | Phase 2 | Pending |
| EXTR-03 | Phase 2 | Pending |
| EXTR-04 | Phase 2 | Pending |
| EXTR-05 | Phase 2 | Pending |
| ENTR-01 | Phase 3 | Pending |
| ENTR-02 | Phase 3 | Pending |
| ENTR-03 | Phase 3 | Pending |
| ENTR-04 | Phase 3 | Pending |
| ENTR-05 | Phase 3 | Pending |
| BTCH-01 | Phase 4 | Pending |
| BTCH-02 | Phase 4 | Pending |
| BTCH-03 | Phase 4 | Pending |
| BTCH-04 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 19 total
- Mapped to phases: 19
- Unmapped: 0

---
*Requirements defined: 2026-03-13*
*Last updated: 2026-03-13 after roadmap creation*
