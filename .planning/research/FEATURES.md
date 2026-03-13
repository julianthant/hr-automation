# Feature Landscape

**Domain:** HR browser automation / RPA -- employee onboarding data transfer between PeopleSoft (UCPath) and Salesforce (ACT CRM)
**Researched:** 2026-03-13

## Table Stakes

Features users expect. Missing = tool feels broken or untrustworthy for daily HR use.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| SSO + MFA-aware login flow | Both UCPath and ACT CRM require UCSD SSO with Duo MFA. If the tool cannot handle login, it cannot do anything. | Medium | Must pause for manual Duo approval -- cannot and should not automate MFA bypass. Playwright `storageState` can persist sessions across runs to reduce re-auth frequency. |
| Cross-system session management | A single browser session must carry auth across both PeopleSoft and Salesforce domains. Separate sessions = broken workflow. | Medium | Both systems share UCSD SSO. One browser context should carry cookies/tokens across both. Must detect session expiry mid-batch and prompt for re-auth. |
| Data extraction from ACT CRM portal | The entire point of the tool: scrape employee onboarding data (names, SSN, position number, address, wage, effective date) from the Salesforce-based portal. | High | Salesforce Lightning uses non-standard Shadow DOM and overrides core JS APIs, making CSS/XPath selectors unreliable. Need resilient locator strategies (ARIA roles, data attributes, text content matching). |
| Data entry into UCPath Smart HR Transactions | The other half of the core value: navigate to Smart HR Transactions, select UC_FULL_HIRE template, enter effective date, create transaction. | High | PeopleSoft has iframes, dynamically generated element IDs, and non-standard HTML patterns. Playwright's `frame_locator()` with auto-wait is the right approach. Selectors must be based on stable attributes (labels, roles), not generated IDs. |
| Batch processing (multiple employees per run) | HR staff process multiple new hires per session. Processing one employee at a time defeats the purpose of automation. | Medium | Accept a list of employee emails as input. Process sequentially (not parallel -- single browser context). Track progress per employee. |
| Error handling with per-employee isolation | If employee #3 of 10 fails, employees #4-10 must still be processed. A single failure cannot crash the entire batch. | Medium | Wrap each employee in try/catch. Log failures with context (which employee, which step, what error). Continue to next employee. Return summary at end. |
| Structured logging and run reports | HR staff need to know what happened: who was processed, what failed, what needs manual follow-up. Managers need audit evidence. | Low | Log every action with timestamps. At batch completion, output a summary: N succeeded, M failed, with details per employee. Write to both console and log file. |
| Credential security | Tool handles SSN, personal data, and login credentials. Any leak is a compliance catastrophe (FERPA, HIPAA-adjacent UC policies). | Low | Credentials in `.env` (not committed). Scraped PII never written to persistent logs. SSN masked in any output (show last 4 only). `.gitignore` must block `.env`, logs with PII, any credential files. |
| Input validation before processing | Bad input (malformed email, missing data) should be caught before the tool starts clicking through UCPath, not after it has partially entered data into a form. | Low | Validate email format, check required fields exist in scraped data before attempting UCPath entry. Fail fast with clear error messages. |
| Resilient element selection | Both PeopleSoft and Salesforce generate dynamic IDs that change per page load. Selectors that work today will break tomorrow if based on generated IDs. | High | Use Playwright locators based on: (1) ARIA roles and labels, (2) text content, (3) data attributes, (4) structural position relative to stable landmarks. Never rely on auto-generated `id` or `class` attributes. Build a selector abstraction layer so selectors are defined in one place, not scattered through code. |

## Differentiators

Features that set this tool apart from "just a script." Not expected on day one, but dramatically increase trust and adoption.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Dry-run / preview mode | Show what data WOULD be entered into UCPath without actually submitting. HR staff can verify correctness before committing. Prevents costly data entry errors in a system where corrections are painful. | Medium | Extract data from ACT CRM, display the mapped fields, show what would be entered into each UCPath field. User confirms before proceeding. Especially critical for SSN, wage, effective date -- errors in these fields have real consequences. |
| Configuration-driven field mapping | Externalize the mapping between ACT CRM fields and UCPath form fields into a config file (JSON/YAML), not hardcoded in source. When UCPath or ACT CRM changes field names or layout, update config, not code. | Medium | Separate concerns: automation engine (how to click/type) vs. data mapping (which source field maps to which target field). Config file should also hold selectors so they can be updated without code changes. |
| Session persistence across runs | Save authenticated browser state (`storageState` in Playwright) so the tool does not require SSO + Duo MFA login on every single run within the same work session. | Low | Playwright natively supports this. Save state to a local file. Check if session is still valid before reusing. If expired, trigger fresh login. Significant time savings for HR staff running multiple batches per day. |
| Smart retry with backoff | When a page element is not found or a navigation times out, retry with exponential backoff before failing. PeopleSoft is slow and occasionally flaky -- a single timeout should not kill a transaction. | Low | Implement retry wrapper: 3 attempts with 2s/4s/8s delays. Distinguish between retryable errors (timeout, element not found yet) and permanent errors (element confirmed absent, wrong page). Log each retry. |
| Progress reporting in terminal | During a 20-employee batch, show live progress: "Processing 7/20: jane.doe@ucsd.edu -- Extracting data from ACT CRM..." HR staff should never wonder "is it stuck or working?" | Low | Simple terminal output per step. For CLI tools, a progress line per employee is sufficient. Avoid complex UI frameworks -- `console.log` with clear formatting is fine. |
| Data verification checkpoints | After extracting data from ACT CRM and before entering it into UCPath, display the extracted data and ask for confirmation (or auto-verify against expected patterns -- e.g., SSN is 9 digits, state is 2-letter code, date is valid). | Low | Pattern-based validation: SSN format, zip code format, state abbreviation, date range sanity checks (effective date not in the past, not years in the future). Flag anomalies, do not silently proceed. |
| Selective re-processing | After a batch run with some failures, allow re-running only the failed employees without re-processing the successful ones. | Low | Persist run results (JSON file with status per employee). Accept `--retry-failed` flag that reads the last run's results and re-processes only failed entries. |
| Screenshot on failure | When an employee transaction fails, capture a screenshot of the browser state at the moment of failure. Invaluable for debugging "why did it fail on this screen?" | Low | Playwright has built-in `page.screenshot()`. Save to a timestamped file per failed employee. Include in the run report. |
| Headless / headed mode toggle | Run headless for unattended batch processing. Run headed (visible browser) for debugging or first-time setup when HR staff want to watch what the tool does. | Low | Playwright supports both natively. Default to headed (builds trust -- users can see what is happening). Add `--headless` flag for experienced users running unattended. |

## Anti-Features

Features to explicitly NOT build. These seem tempting but would introduce risk, complexity, or maintenance burden disproportionate to their value.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Automated Duo MFA bypass | Illegal under UC policy. Violates the purpose of MFA. Would require storing TOTP secrets or intercepting push notifications. Any security audit would flag this immediately. | Pause for manual Duo approval. Display a clear prompt: "Approve Duo push on your phone, then press Enter." This is the correct approach per project constraints. |
| Web UI / dashboard | Massive increase in scope (frontend framework, hosting, auth layer, state management). The user base is small (UCSD HR staff) and a CLI is sufficient for v1. | CLI-first. If a UI is ever needed, it is a separate project/milestone. |
| Full UC_FULL_HIRE form automation | The full hire form has dozens of fields with complex conditional logic, dropdown dependencies, and approval workflows. Automating the entire form is a v2 effort. | v1: automate up to "Create Transaction" (template selection + effective date). v2: fill remaining fields. This is already scoped correctly in PROJECT.md. |
| Parallel browser instances | Running multiple browser tabs/windows to process employees in parallel. PeopleSoft is not designed for concurrent form entry from the same session -- it will corrupt data or lock. | Sequential processing. One employee at a time. Batch processing provides the speed improvement; parallelism adds risk without proportional benefit. |
| Database for storing employee data | Storing extracted PII in a local database adds security exposure, compliance burden, and maintenance overhead. The data already lives in ACT CRM and UCPath. | In-memory only during processing. Write structured run logs (success/fail per employee, no PII) to a JSON file. Never persist SSN, addresses, or other PII to disk. |
| Email/Slack notifications on completion | Scope creep. Adds dependencies on email servers or Slack APIs. HR staff are sitting at their desk running the tool -- they will see the results in the terminal. | Terminal output with clear summary. If notifications are ever needed, it is a future enhancement, not a v1 feature. |
| Support for other HR templates beyond UC_FULL_HIRE | Each template has different fields, logic, and workflows. Supporting multiple templates multiplies testing and maintenance. | Build the architecture so adding templates is possible later (config-driven field mapping helps), but only implement UC_FULL_HIRE for now. |
| Scheduling / cron-based automated runs | Requires unattended execution, which conflicts with the Duo MFA pause requirement. Also raises questions about error handling when no human is watching. | Manual CLI invocation. HR staff run the tool when they have a batch to process. They are present for Duo approval and can handle errors. |

## Feature Dependencies

```
SSO + MFA Login ──> Cross-System Session Management ──> Data Extraction (ACT CRM)
                                                    ──> Data Entry (UCPath)

Data Extraction (ACT CRM) ──> Input Validation ──> Data Verification Checkpoints
                                                ──> Dry-Run / Preview Mode
                                                ──> Data Entry (UCPath)

Batch Processing ──> Per-Employee Error Isolation ──> Structured Logging
                                                  ──> Selective Re-Processing
                                                  ──> Progress Reporting

Resilient Element Selection ──> Data Extraction (ACT CRM)
                            ──> Data Entry (UCPath)

Configuration-Driven Field Mapping ──> Data Extraction (flexible)
                                   ──> Data Entry (flexible)
                                   ──> Future template support (extensibility)

Error Handling ──> Screenshot on Failure
              ──> Smart Retry with Backoff
              ──> Selective Re-Processing
```

Key dependency insight: **Resilient element selection** and **SSO/MFA login** are foundation-layer features. Everything else depends on being able to reliably find elements on PeopleSoft and Salesforce pages, and being authenticated to do so. These must be rock-solid before building higher-level features.

## MVP Recommendation

### Phase 1: Foundation (must work before anything else)

1. **SSO + MFA-aware login flow** -- the gateway to both systems
2. **Cross-system session management** -- carry auth across UCPath and ACT CRM
3. **Resilient element selection layer** -- stable selectors for PeopleSoft iframes and Salesforce Shadow DOM
4. **Credential security** -- `.env` handling, `.gitignore`, PII protection from day one

### Phase 2: Core Workflow (the actual value delivery)

5. **Data extraction from ACT CRM portal** -- scrape employee data by email lookup
6. **Data entry into UCPath Smart HR Transactions** -- navigate to template, enter effective date, create transaction
7. **Input validation** -- catch bad data before touching UCPath
8. **Structured logging** -- know what happened per run

### Phase 3: Batch and Reliability (scale from one to many)

9. **Batch processing** -- accept multiple employee emails
10. **Per-employee error isolation** -- one failure does not kill the batch
11. **Progress reporting** -- terminal output per employee
12. **Smart retry with backoff** -- handle PeopleSoft flakiness gracefully

### Defer to Later

- **Dry-run / preview mode**: High value but requires the core workflow to exist first. Add after Phase 2 is stable.
- **Configuration-driven field mapping**: Valuable for maintainability but not blocking v1. Hardcode initially, extract to config when patterns stabilize.
- **Session persistence**: Low effort, add when login friction becomes annoying (likely during Phase 3 testing).
- **Screenshot on failure**: Low effort, add alongside error isolation in Phase 3.
- **Selective re-processing**: Requires structured run results from Phase 3 logging. Natural Phase 4 feature.
- **Headless mode toggle**: Trivial to add anytime. Default to headed for v1.

## Sources

- [UCSB: HRIS Smart HR Template Transactions](https://www.hr.ucsb.edu/hr-units/workforce-administration/wfa-smart-hr-template-transactions)
- [UCSD: Smart HR Template Transactions Job Aids](https://ucpath.ucsd.edu/transactors/ucpath-job-aids/smart-hr.html)
- [UCI: Template Transactions Training (PDF)](https://www.ucpath.uci.edu/training/docs/template_transactions_p1.pdf)
- [Automation Anywhere: Employee Onboarding Automation](https://www.automationanywhere.com/solutions/human-resources/employee-onboarding-automation)
- [Automation Anywhere: Six Onboarding Challenges and How RPA Helps](https://www.automationanywhere.com/company/blog/rpa-thought-leadership/six-challenges-of-employee-onboarding-and-how-rpa-can-help)
- [TechTarget: How RPA Can Simplify the Onboarding Process](https://www.techtarget.com/searchhrsoftware/feature/How-RPA-can-simplify-the-onboarding-process)
- [Skyvern: Error Handling in Browser Automation](https://www.skyvern.com/blog/error-handling-in-browser-automation/)
- [The Green Report: Enhancing Automation Reliability with Retry Patterns](https://www.thegreenreport.blog/articles/enhancing-automation-reliability-with-retry-patterns/enhancing-automation-reliability-with-retry-patterns.html)
- [Elio Struyf: E2E Testing in MFA Environment with Playwright Auth Session](https://www.eliostruyf.com/e2e-testing-mfa-environment-playwright-auth-session/)
- [Sogeti Labs: Automating MFA Testing with Playwright Storage State](https://labs.sogeti.com/conquering-mfa-how-playwrights-built-in-storage-state-revolutionizes-multi-factor-authentication-testing/)
- [KMS Technology: Automation Testing with Playwright + Salesforce](https://kms-technology.com/salesforce/automation-testing-with-playwright-salesforce.html)
- [ZeroStep: Testing Salesforce with Playwright and Generative AI](https://zerostep.com/blog/testing-salesforce-with-playwright-and-generative-ai/)
- [TestMu: Handling iFrames in Playwright](https://www.testmuai.com/learning-hub/handling-iframes-in-playwright/)
- [Browserless: Playwright vs Selenium 2025](https://www.browserless.io/blog/playwright-vs-selenium-2025-browser-automation-comparison)
- [NIST SP 800-122: Guide to Protecting PII Confidentiality](https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-122.pdf)
- [Virtru: PII Encryption Best Practices](https://www.virtru.com/blog/compliance/hipaa/pii-encryption-best-practices)
- [Symphony: RPA Technical Insights -- Security Logging](https://blog.symphonyhq.com/rpa-technical-insights-part-17-security-logging-your-automation-activity)
- [CAI: RPA Exception Handling](https://www.cai.io/resources/thought-leadership/rpa-exception-handling-be-in-control-or-be-controlled)
- [Blue Prism: Configuration Files in RPA](https://community.blueprism.com/t5/Product-Forum/BPTechTips-TipOfTheDay-Configuration-Files-in-RPA/td-p/51353)
- [Dev.to: Dry-Run Engineering](https://dev.to/danieljglover/dry-run-engineering-the-simple-practice-that-prevents-production-disasters-ek0)
