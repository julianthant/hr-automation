# Architecture Research

**Domain:** HR Browser Automation / RPA -- Cross-application data transfer (Salesforce-based CRM to PeopleSoft-based UCPath)
**Researched:** 2026-03-13
**Confidence:** HIGH

## Standard Architecture

### System Overview

```
+------------------------------------------------------------------+
|                          CLI Layer                                |
|  +-----------+  +----------------+  +-------------------------+  |
|  | Commander |  | Config/Env     |  | Progress Reporter       |  |
|  | (entry)   |  | (.env loader)  |  | (batch status + logs)   |  |
|  +-----+-----+  +-------+--------+  +------------+------------+  |
|        |                |                        |               |
+--------+----------------+------------------------+---------------+
|                      Orchestrator                                |
|  +-----------------------------------------------------------+  |
|  |  Workflow Engine (sequences steps, manages batch queue)    |  |
|  |  - Auth flow -> Scrape flow -> Entry flow (per employee)   |  |
|  +----------------------------+------------------------------+  |
|                               |                                  |
+-------------------------------+----------------------------------+
|                     Page Object Layer                            |
|  +----------------+  +----------------+  +-------------------+   |
|  | SSO Login Page |  | ACT CRM Pages  |  | UCPath Pages      |   |
|  | (Duo MFA wait) |  | (Portal, Entry |  | (Nav, SmartHR,    |   |
|  |                |  |  Sheet)        |  |  Transaction)     |   |
|  +-------+--------+  +-------+--------+  +---------+---------+   |
|          |                   |                      |            |
+----------+-------------------+----------------------+------------+
|                     Browser Engine                               |
|  +-----------------------------------------------------------+  |
|  |  Playwright (persistent context, single browser instance)  |  |
|  |  - Shared session cookies across both target sites         |  |
|  |  - iframe handling for PeopleSoft                          |  |
|  +-----------------------------------------------------------+  |
|                                                                  |
+------------------------------------------------------------------+
|                     Data Layer                                   |
|  +----------------+  +-------------------+  +----------------+   |
|  | Employee       |  | Validation        |  | Run Log /      |   |
|  | Schema (Zod)   |  | + Transform       |  | Audit Trail    |   |
|  +----------------+  +-------------------+  +----------------+   |
+------------------------------------------------------------------+
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| CLI Entry | Parse commands, accept email list input, surface help | Commander.js with subcommands (`run`, `test-login`, `dry-run`) |
| Config/Env | Load credentials, URLs, timeouts from `.env` | `dotenv` package, validated by Zod schema at startup |
| Progress Reporter | Show batch progress, per-employee status, errors | Console output with structured log lines (not a spinner -- needs auditability) |
| Workflow Orchestrator | Sequence the full pipeline: auth, scrape, enter, repeat per employee | Async function chain with error boundaries per employee |
| SSO Login Page Object | Navigate to SSO, enter credentials, pause for Duo MFA, detect success | Playwright page interactions + explicit wait for user's MFA approval |
| ACT CRM Page Objects | Search by email, select correct row, extract employee data fields | Playwright locators on Salesforce community portal markup |
| UCPath Page Objects | Navigate PeopleSoft menus, fill Smart HR transaction, handle iframes | Playwright frameLocator() for PeopleSoft iframes, resilient selectors |
| Employee Schema | Define and validate the shape of scraped employee data | Zod schema with `.transform()` for field normalization |
| Validation + Transform | Ensure scraped data is complete/valid before entry, normalize formats | Zod `.safeParse()` -- fail the employee gracefully if data is bad |
| Run Log / Audit Trail | Record what happened per employee: success, failure, skipped, why | JSON log file per run, written to `./logs/` |

## Recommended Project Structure

```
src/
  cli/                  # CLI entry point and command definitions
    index.ts            # Commander setup, subcommands
    commands/
      run.ts            # Main batch processing command
      test-login.ts     # Test SSO auth without processing
      dry-run.ts        # Scrape only, no UCPath entry
  orchestrator/         # Workflow sequencing
    pipeline.ts         # Full pipeline: auth -> scrape -> enter
    batch.ts            # Batch loop over employee list
  pages/                # Page Object Model -- one class per page/screen
    base-page.ts        # Shared helpers (waitForNav, screenshotOnError)
    sso-login.page.ts   # UCSD SSO + Duo MFA flow
    act-crm/
      portal.page.ts    # Onboarding portal search + row selection
      entry-sheet.page.ts  # Employee data extraction
    ucpath/
      navigation.page.ts   # PeopleSoft homepage -> Smart HR
      smart-hr.page.ts     # Template selection, transaction creation
  data/                 # Schemas, validation, transformation
    employee.schema.ts  # Zod schema for employee record
    validators.ts       # Pre-entry validation rules
    transformers.ts     # Field format normalization (dates, SSN masking in logs)
  browser/              # Playwright lifecycle management
    context.ts          # Browser launch, persistent context, teardown
    session.ts          # Session state save/restore helpers
  config/               # Configuration loading and validation
    env.ts              # dotenv loading + Zod validation of env vars
    constants.ts        # URLs, timeouts, selectors that rarely change
  logging/              # Structured logging and audit trail
    logger.ts           # Log setup (console + file)
    audit.ts            # Per-employee result recording
.env                    # Credentials (git-ignored)
.env.example            # Template showing required vars (no secrets)
logs/                   # Run logs (git-ignored)
```

### Structure Rationale

- **`pages/`:** Page Object Model is the standard for browser automation. Each page object encapsulates the selectors and interactions for one screen, so when UCPath or ACT CRM changes their UI, you fix one file, not every test. Subdirectories (`act-crm/`, `ucpath/`) mirror the two target systems.
- **`orchestrator/`:** Separates "what to do" (pipeline steps) from "how to interact with a page" (page objects). The orchestrator calls page objects but never touches selectors directly. This is the key architectural boundary.
- **`data/`:** Scraped data must be validated before being typed into UCPath. A dedicated data layer with Zod schemas catches missing fields, bad formats, or partial scrapes before they become bad transactions in UCPath.
- **`browser/`:** Isolates Playwright lifecycle (launch, context, teardown) from business logic. If you ever swap Playwright for something else (unlikely but possible), changes stay here.
- **`cli/`:** Thin layer. Commands parse args and call into the orchestrator. No business logic in CLI handlers.

## Architectural Patterns

### Pattern 1: Page Object Model (POM)

**What:** Each page or major screen in a target application is represented by a class. The class owns all selectors for that page and exposes methods for user-visible actions (not raw clicks).
**When to use:** Always in browser automation. This is not optional for maintainability.
**Trade-offs:** Slight upfront effort to structure classes, but pays back immediately when selectors break (and they will break, especially with PeopleSoft's dynamic IDs).

**Example:**
```typescript
// pages/ucpath/smart-hr.page.ts
import { Page, FrameLocator } from 'playwright';

export class SmartHRPage {
  private page: Page;
  private mainFrame: FrameLocator;

  constructor(page: Page) {
    this.page = page;
    // PeopleSoft wraps content in an iframe
    this.mainFrame = page.frameLocator('#ptifrmtgtframe');
  }

  async selectTemplate(templateName: string) {
    await this.mainFrame
      .locator('[id^="TEMPLATE_NAME"]')  // partial match -- ID suffix changes
      .selectOption(templateName);
  }

  async setEffectiveDate(date: string) {
    await this.mainFrame
      .locator('[id^="EFFDT"]')
      .fill(date);
  }

  async createTransaction() {
    await this.mainFrame
      .locator('input[value="Create Transaction"]')
      .click();
    await this.page.waitForLoadState('networkidle');
  }
}
```

### Pattern 2: Pipeline Orchestration with Per-Employee Error Boundaries

**What:** The batch workflow loops over employees, wrapping each iteration in a try/catch so one failure does not abort the entire batch. Each employee's result (success/failure/skipped) is logged independently.
**When to use:** Always for batch processing. Users process multiple employees per session and need most of them to succeed even if one has bad data.
**Trade-offs:** Adds complexity to error reporting, but the alternative (fail-fast on first error) is unacceptable for HR workflows where users need to process 10+ employees at a time.

**Example:**
```typescript
// orchestrator/batch.ts
import { EmployeeResult } from '../data/employee.schema';

interface BatchResult {
  total: number;
  succeeded: string[];
  failed: { email: string; error: string }[];
  skipped: { email: string; reason: string }[];
}

async function processBatch(emails: string[]): Promise<BatchResult> {
  const result: BatchResult = {
    total: emails.length,
    succeeded: [],
    failed: [],
    skipped: [],
  };

  for (const email of emails) {
    try {
      const data = await scrapeEmployee(email);
      const validated = employeeSchema.safeParse(data);

      if (!validated.success) {
        result.skipped.push({
          email,
          reason: `Validation failed: ${validated.error.message}`,
        });
        continue;
      }

      await enterIntoUCPath(validated.data);
      result.succeeded.push(email);
    } catch (error) {
      result.failed.push({ email, error: String(error) });
    }
  }

  return result;
}
```

### Pattern 3: Resilient Selectors for PeopleSoft

**What:** PeopleSoft generates dynamic element IDs (e.g., `DERIVED_HR_123` where `123` changes). Selectors must use partial attribute matching, text content, or structural position rather than exact IDs.
**When to use:** All UCPath page objects. Every selector touching PeopleSoft content.
**Trade-offs:** Partial-match selectors are slightly less precise but dramatically more stable. Always prefer `[id^="PREFIX"]` or `text=` locators over exact ID matching for PeopleSoft.

**Example:**
```typescript
// Fragile -- will break when PeopleSoft regenerates IDs:
page.locator('#DERIVED_HR_FL_DESCR100_42');

// Resilient -- matches by prefix, survives ID changes:
frame.locator('[id^="DERIVED_HR_FL_DESCR100"]');

// Even more resilient -- matches by visible text:
frame.locator('a:has-text("Smart HR Templates")');

// Most resilient for navigation -- combine structure + text:
frame.locator('#ptnav a >> text=Smart HR Transactions');
```

### Pattern 4: MFA Pause Gate

**What:** The automation pauses at a known point (after entering credentials, before Duo approval) and waits for the user to complete MFA on their phone. Detection uses a reliable post-login indicator (URL change, presence of a dashboard element).
**When to use:** The SSO login page object. This is a hard requirement since Duo MFA cannot be automated.
**Trade-offs:** Introduces a manual step into an "automated" tool. But this is a legal/security requirement, not a shortcoming. The pause should be clearly communicated to the user via console output.

**Example:**
```typescript
// pages/sso-login.page.ts
async waitForMfaApproval(timeoutMs: number = 120_000) {
  console.log('Waiting for Duo MFA approval -- check your phone...');

  // Wait for the SSO redirect to complete (lands on target app)
  await this.page.waitForURL('**/ucpath.ucsd.edu/**', {
    timeout: timeoutMs,
  });

  console.log('MFA approved. Continuing...');
}
```

## Data Flow

### Primary Data Flow: Employee Onboarding

```
User (CLI)
    |
    | provides: list of employee emails
    v
Orchestrator
    |
    | 1. launches browser, navigates to SSO
    v
SSO Login Page -----> User approves Duo MFA on phone
    |
    | 2. authenticated session (cookies shared across both sites)
    v
+-- FOR EACH employee email: --------------------------------+
|                                                            |
|   ACT CRM Portal Page                                     |
|       | 3. search by email, select latest-dated row        |
|       v                                                    |
|   ACT CRM Entry Sheet Page                                |
|       | 4. extract: position#, names, SSN, address,        |
|       |    city, state, zip, wage, effective date           |
|       v                                                    |
|   Employee Schema (Zod)                                    |
|       | 5. validate extracted data, normalize formats       |
|       |    (fail-safe: skip this employee if invalid)       |
|       v                                                    |
|   UCPath Navigation Page                                   |
|       | 6. navigate PeopleSoft menus to Smart HR            |
|       v                                                    |
|   UCPath Smart HR Page                                     |
|       | 7. select UC_FULL_HIRE template, enter date,        |
|       |    click Create Transaction                         |
|       v                                                    |
|   Audit Log                                                |
|       | 8. record result: success / failure / skipped       |
|                                                            |
+-- NEXT employee ------------------------------------------+
    |
    v
Batch Summary (console + log file)
    | total: N, succeeded: X, failed: Y, skipped: Z
```

### Session Management Flow

```
Browser Launch (persistent context)
    |
    v
SSO Login (once per session)
    |
    | cookies stored in browser context
    v
ACT CRM requests -----> cookies sent automatically (same SSO domain)
    |
UCPath requests -------> cookies sent automatically (same SSO domain)
    |
    | Session valid for duration of browser instance
    | No need for separate auth per system
    v
Browser Close (session ends)
```

### Key Data Flows

1. **Employee data extraction (ACT CRM -> memory -> UCPath):** Data is scraped from the ACT CRM entry sheet into a typed object, validated through a Zod schema, then used to fill UCPath form fields. Data never touches disk in raw form (SSNs stay in memory only). The Zod schema acts as the contract between the scrape step and the entry step.

2. **Authentication state (browser -> both sites):** A single Playwright persistent browser context holds SSO cookies that authenticate against both ACT CRM and UCPath. There is no separate login for each system. The browser context is the session store.

3. **Batch results (orchestrator -> log + console):** Each employee's outcome flows to both the console (real-time progress) and a JSON log file (post-run audit). The log includes timestamps, employee identifier (email, not SSN), and error details for failures.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1-10 employees/run | Current architecture is fine. Sequential processing. Single browser. |
| 10-50 employees/run | Still sequential (both target apps are stateful web UIs -- no parallelism possible within one session). Add progress percentage to console output. Consider session timeout detection + re-auth. |
| 50+ employees/run | Consider splitting into batches with session refresh between batches. PeopleSoft sessions may time out. Add checkpoint/resume capability (skip already-processed employees). |

### Scaling Priorities

1. **First bottleneck: PeopleSoft session timeout.** PeopleSoft sessions typically expire after 20-30 minutes of inactivity on a given page. For large batches, detect timeout (page redirects to login) and re-authenticate automatically rather than failing the entire remaining batch.

2. **Second bottleneck: Rate/usage patterns.** If UCPath has any rate limiting or detects rapid form submissions, add configurable delays between employees. Start with a reasonable pause (2-3 seconds between transactions) and make it configurable.

## Anti-Patterns

### Anti-Pattern 1: Exact PeopleSoft Selectors

**What people do:** Use exact element IDs copied from browser DevTools, like `#DERIVED_HR_FL_DESCR100_42`.
**Why it's wrong:** PeopleSoft regenerates numeric suffixes on these IDs across sessions, pages, and sometimes even within the same page load. Tests pass today, break tomorrow.
**Do this instead:** Use prefix-based attribute selectors (`[id^="DERIVED_HR_FL"]`), text-based locators (`text=Smart HR`), or structural selectors. Define all selectors in the page object, not inline.

### Anti-Pattern 2: No Validation Between Scrape and Entry

**What people do:** Scrape fields from ACT CRM and immediately type them into UCPath without validation.
**Why it's wrong:** Partial page loads, changed layouts, or missing data in the source system produce garbage input. Entering bad data into UCPath is worse than entering no data -- it creates HR records that must be manually corrected or reversed.
**Do this instead:** Always pass scraped data through a Zod schema with `.safeParse()`. If validation fails, skip that employee and log the specific validation error. Never enter unvalidated data.

### Anti-Pattern 3: Monolithic Script Without Page Objects

**What people do:** Write a single long script file with all selectors, navigation, data extraction, and form filling inline.
**Why it's wrong:** When either target system changes its UI (and they will), you cannot isolate what broke. Every change requires reading through hundreds of lines. Testing individual steps is impossible.
**Do this instead:** Page Object Model. One class per page. Orchestrator calls page objects. Selectors live in exactly one place.

### Anti-Pattern 4: Logging SSNs or Sensitive Data

**What people do:** Log the full employee record including SSN for debugging.
**Why it's wrong:** Log files persist on disk, may be shared, and create compliance liability. SSNs in log files violate data handling requirements.
**Do this instead:** Log employee email (the lookup key) but never SSN, full name + address combinations, or other PII beyond what is needed to identify which employee a log entry refers to. If SSN must appear in debug output, mask it (`***-**-1234`).

### Anti-Pattern 5: Hardcoded Waits Instead of Condition Waits

**What people do:** Use `page.waitForTimeout(5000)` after every action.
**Why it's wrong:** Either too slow (wastes time when page loads fast) or too fast (breaks on slow connections). PeopleSoft page load times vary dramatically.
**Do this instead:** Use Playwright's built-in auto-waiting via locators, `waitForLoadState('networkidle')`, or `waitForURL()`. Only use explicit timeouts as a last-resort maximum bound, not as the primary wait mechanism.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| UCSD SSO (Shibboleth) | Browser-based login via Playwright page interactions | Redirects through multiple domains. Playwright handles redirects natively. Must detect final landing URL to confirm success. |
| Duo MFA | Manual pause -- user approves on phone, automation detects completion | Cannot be automated. Detect via URL change or post-login element appearing. Generous timeout (2 minutes). |
| ACT CRM (Salesforce Community) | Playwright scraping of Salesforce Lightning/community portal pages | Salesforce renders client-side. Use `waitForLoadState('networkidle')` to ensure content renders before scraping. |
| UCPath (PeopleSoft) | Playwright form entry within PeopleSoft iframe structure | Always access via `frameLocator('#ptifrmtgtframe')`. PeopleSoft uses server-side rendering within iframes, so `networkidle` is reliable for load detection. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| CLI -> Orchestrator | Function call (direct) | CLI parses args, calls orchestrator with typed config object. No IPC. |
| Orchestrator -> Page Objects | Function call (direct) | Orchestrator calls page object methods. Page objects return typed data or throw on failure. |
| Page Objects -> Browser | Playwright API | Page objects hold a `Page` reference. One `Page` instance shared across all page objects in a run. |
| Scrape Output -> Entry Input | Zod schema (data contract) | The employee schema is the contract. Scrape side must produce data that passes the schema. Entry side can trust validated data. This is the most important boundary in the system. |
| Orchestrator -> Logger | Function call (fire-and-forget) | Logging should never throw or block the pipeline. Wrap log writes in try/catch. |

## Build Order (Dependencies)

The architecture has clear dependency layers that dictate build order:

```
Phase 1: Browser + Auth Foundation
   browser/context.ts -> pages/sso-login.page.ts -> config/env.ts
   (Everything depends on being able to launch a browser and authenticate)

Phase 2: Scrape Side (ACT CRM)
   pages/act-crm/portal.page.ts -> pages/act-crm/entry-sheet.page.ts
   data/employee.schema.ts -> data/validators.ts
   (Can be built and tested independently of UCPath entry)

Phase 3: Entry Side (UCPath)
   pages/ucpath/navigation.page.ts -> pages/ucpath/smart-hr.page.ts
   (Depends on auth from Phase 1; consumes data shaped by Phase 2)

Phase 4: Orchestration + CLI
   orchestrator/pipeline.ts -> orchestrator/batch.ts
   cli/ commands
   logging/
   (Wires everything together. Build last because it depends on all above.)
```

**Rationale:** Each phase is independently testable. Phase 1 can be validated by simply logging in and taking a screenshot. Phase 2 can be validated by scraping one employee and printing the result. Phase 3 can be validated by navigating to the Smart HR screen. Phase 4 wires the complete flow.

## Sources

- [Playwright Page Object Model documentation](https://playwright.dev/docs/pom) -- official pattern guidance
- [Playwright Authentication documentation](https://playwright.dev/docs/auth) -- session reuse patterns
- [Playwright iframe handling](https://www.testmu.ai/learning-hub/handling-iframes-in-playwright/) -- frameLocator patterns for PeopleSoft
- [RPA Architecture patterns](https://www.t-plan.com/rpa-architecture/) -- cross-application data transfer patterns
- [RPA with Playwright](https://step.dev/tutorials/robotic-process-automation-rpa-with-playwright/) -- Playwright for RPA workflows
- [Zod schema validation](https://zod.dev/) -- data validation layer
- [Playwright persistent context](https://www.browserstack.com/guide/playwright-persistent-context) -- session management
- [Playwright error handling and retries](https://www.neovasolutions.com/2024/08/15/effective-error-handling-and-retries-in-playwright-tests/) -- resilience patterns
- [Playwright SSO handling](https://github.com/microsoft/playwright/issues/5053) -- SSO login automation
- [PeopleSoft Test Framework](https://elire.com/webinar-quest-psft-week-peoplesoft-automation-with-ptf/) -- PeopleSoft automation context
- [Salesforce automation with Playwright](https://github.com/TestLeafInc/playwright-salesforce) -- Salesforce-specific patterns

---
*Architecture research for: UCPath HR Automation (cross-system browser automation)*
*Researched: 2026-03-13*
