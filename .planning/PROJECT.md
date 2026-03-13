# UCPath HR Automation

## What This Is

A browser automation tool that streamlines employee onboarding at UCSD by scraping new hire data from the ACT CRM onboarding portal and programmatically entering it into UCPath's Smart HR Transactions system. Built for UCSD HR staff who currently perform this multi-system copy-paste workflow manually.

## Core Value

Reliably transfer employee onboarding data from the ACT CRM portal into UCPath's UC_FULL_HIRE template without manual copy-pasting — handling login, navigation, data extraction, and form entry across both systems.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

(None yet — ship to validate)

### Active

<!-- Current scope. Building toward these. -->

- [ ] Automate UCPath login via UCSD SSO (navigate to ucpath.ucsd.edu, click login, select UC San Diego, enter credentials, pause for Duo MFA approval, detect successful login)
- [ ] Automate ACT CRM onboarding portal login (https://act-crm.my.site.com/hr/a1Z/o) via same UCSD SSO session
- [ ] Navigate UCPath to Smart HR Transactions (PeopleSoft Homepage → HR Tasks → Smart HR Templates dropdown → Smart HR Transactions)
- [ ] Search onboarding portal by employee email, select row with latest date
- [ ] Extract employee data from UCPath Entry Sheet (position number, names, SSN, address, city, state, postal code, wage, effective date)
- [ ] In UCPath Smart HR Transactions, select template UC_FULL_HIRE, enter effective date, click Create Transaction
- [ ] Accept a list of employee emails as input (batch processing)
- [ ] Store credentials securely in .env file (not committed to git)

### Out of Scope

- Filling the full UC_FULL_HIRE form after Create Transaction — deferred to v2
- Automating Duo MFA approval — will pause for manual phone approval
- Web frontend/UI — CLI-first, may add later
- Other HR workflows beyond onboarding — future milestones
- Employee offboarding, pay changes, position changes — future milestones

## Context

- **UCPath**: UC systemwide HR/payroll platform built on PeopleSoft. Accessed via https://ucpath.ucsd.edu/
- **ACT CRM Onboarding Portal**: Salesforce-based system at https://act-crm.my.site.com/hr/a1Z/o where new hire info is collected
- **Authentication**: Both systems use UCSD SSO with Duo MFA. A single browser session should carry authentication across both. If ACT CRM requires separate login, must select "Active Directory" from the login dropdown before entering credentials
- **No API access**: Neither system exposes APIs for this workflow, requiring browser automation (Playwright/Selenium)
- **PeopleSoft quirks**: UCPath is PeopleSoft-based — expect iframes, dynamic element IDs, and non-standard HTML patterns
- **Data flow**: Onboarding Portal → extract employee data → UCPath Smart HR Transactions → UC_FULL_HIRE template

## Constraints

- **No API**: Must use browser automation (scraping) — no REST/GraphQL endpoints available
- **Auth**: UCSD SSO + Duo MFA required; automation must pause for human Duo approval
- **Security**: SSN and personal data handled — credentials and scraped data must never be committed to git
- **Browser session**: Must maintain session state across both systems in same browser instance
- **PeopleSoft**: UCPath uses PeopleSoft which has iframes and dynamically generated element IDs — selectors need to be resilient

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Browser automation over API | No API access available | — Pending |
| CLI-first, no web UI for v1 | Get core automation working before adding UI layer | — Pending |
| Pause for Duo MFA | Cannot safely/legally automate MFA bypass | — Pending |
| Search by email, not name | Email is unique identifier; names can be ambiguous | — Pending |
| Batch processing via email list | User processes multiple employees per session | — Pending |

---
*Last updated: 2026-03-13 after initialization*
