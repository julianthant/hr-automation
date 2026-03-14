# Phase 3: UCPath Transaction Entry - Research

**Researched:** 2026-03-14
**Domain:** PeopleSoft navigation, Smart HR Transactions, dry-run automation pattern
**Confidence:** HIGH (stack/patterns/dry-run) / MEDIUM (PeopleSoft selectors -- require live discovery)

## Summary

Phase 3 builds on the authenticated UCPath browser session from Phase 1 and the validated employee data from Phase 2 to navigate PeopleSoft's Smart HR Transactions interface, select the UC_FULL_HIRE template, enter an effective date, and click Create Transaction. The phase also introduces a dry-run mode that previews every intended action without touching UCPath -- critical because UCPath transactions cannot be undone once created.

The core technical challenge is PeopleSoft navigation. UCPath is PeopleSoft-based, which means iframes, dynamically generated element IDs, and server-side form processing with "ICAction" hidden fields. The existing codebase already handles UCPath authentication (Phase 1) with a separate browser for UCPath. Phase 3 adds a new `src/ucpath/` module (the stub already exists at `src/ucpath/index.ts`) containing navigation and transaction creation logic, plus a dry-run engine that builds an action plan before executing it.

The navigation path is: PeopleSoft Homepage > HR Tasks tile > Smart HR Templates dropdown > Smart HR Transactions. Once on the Smart HR Transactions page (PeopleSoft component `HR_TBH_EULIST`), the automation must select the UC_FULL_HIRE template from a dropdown, enter the effective date, and click "Create Transaction." PeopleSoft wraps all page content in an iframe (`#ptifrmtgtframe` / name `TargetContent`), so every interaction after initial navigation requires `page.frameLocator('#ptifrmtgtframe')`. Selectors will be best-guess placeholders marked with `// SELECTOR:` comments, following the established pattern from Phases 1 and 2, and will require live discovery.

**Primary recommendation:** Build a transaction entry module under `src/ucpath/` with an action-plan pattern for dry-run support. Use PeopleSoft direct URL navigation where possible (per user preference for URL params over UI clicking). All selectors are placeholders pending live testing. Include a dedicated live discovery plan, following the proven Phase 2 approach.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| ENTR-01 | Automation navigates UCPath to Smart HR Transactions (Homepage > HR Tasks > Smart HR Templates dropdown > Smart HR Transactions) | PeopleSoft navigation via homepage tiles + NavBar menu OR direct URL navigation -- see Architecture Patterns "UCPath Navigation" |
| ENTR-02 | Automation selects template UC_FULL_HIRE in the template selector | PeopleSoft dropdown interaction via `selectOption()` inside iframe -- see Architecture Patterns "Template Selection" |
| ENTR-03 | Automation enters the effective date from extracted data into the date field | PeopleSoft date input with Tab key for server validation -- see Common Pitfalls "Tab Key After Input" |
| ENTR-04 | Automation clicks Create Transaction | Button click inside PeopleSoft iframe + confirmation detection -- see Architecture Patterns "Transaction Creation" |
| ENTR-05 | User can run in dry-run mode that shows extracted data and intended actions without submitting to UCPath | Action plan pattern with dry-run flag -- see Architecture Patterns "Dry-Run Engine" |
</phase_requirements>

## Standard Stack

### Core (existing -- no changes)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| playwright | ^1.58.2 | Browser automation, iframe handling, PeopleSoft navigation | Already installed; `frameLocator()` for PeopleSoft iframes |
| typescript | ^5.9.3 | Type safety | Already installed; types for action plans and transaction state |
| tsx | ^4.21.0 | TypeScript execution | Already installed; zero-config runner |
| commander | ^14.0.3 | CLI argument parsing | Already installed; will add `create-transaction` command with `--dry-run` flag |
| picocolors | ^1.1.1 | Terminal colors | Already installed; dry-run output formatting |
| zod | ^4.3.6 | Schema validation | Already installed; EmployeeData type used as input |

### New Dependencies
None. Phase 3 uses only existing dependencies.

### Not Needed
| Problem | Skip This | Use Instead | Why |
|---------|-----------|-------------|-----|
| Date formatting | date-fns / dayjs | String manipulation | Effective date is already in MM/DD/YYYY format from Phase 2 Zod schema |
| PeopleSoft API | REST/SOAP clients | Playwright browser automation | No API access available (project constraint) |
| Confirmation parsing | cheerio / jsdom | Playwright locators | Playwright already has the DOM loaded |

## Architecture Patterns

### Recommended Project Structure (additions to existing)
```
src/
  ucpath/
    index.ts          # (exists, currently stub) -- barrel export
    navigate.ts       # ENTR-01: PeopleSoft menu/URL navigation
    transaction.ts    # ENTR-02, ENTR-03, ENTR-04: Template selection + create
    types.ts          # TransactionResult, TransactionAction types
    action-plan.ts    # ENTR-05: Dry-run action plan engine
  workflows/
    onboarding/
      enter.ts        # Onboarding-specific entry orchestration (uses ucpath/ modules)
  cli.ts              # Add create-transaction command
```

### Pattern 1: UCPath Navigation (ENTR-01)
**What:** Navigate from the PeopleSoft homepage to the Smart HR Transactions page. Two strategies: (A) direct URL navigation if the URL pattern is discovered during live testing, (B) tile/menu clicking as fallback.
**When to use:** Every transaction entry invocation, before template selection.
**Key insight:** PeopleSoft URLs follow a predictable pattern: `https://<host>/psc/<instance>/EMPLOYEE/<node>/c/<MENU>.<COMPONENT>.GBL`. If the Smart HR Transactions component URL can be discovered during live testing, use `page.goto()` directly (per user preference for URL params over UI clicking). Fall back to menu navigation only if direct URL does not work.

**Strategy A -- Direct URL (preferred, requires live discovery):**
```typescript
// Source: PeopleSoft URL convention + user preference (feedback_url_params.md)
// The URL pattern will be discovered during live testing
// Example pattern: https://ucpath.universityofcalifornia.edu/psc/.../c/WORKFORCE_ADMIN.HR_TBH_EULIST.GBL
async function navigateToSmartHR(page: Page): Promise<void> {
  // SELECTOR: URL to be discovered during live testing
  const smartHrUrl = "https://..."; // placeholder
  await page.goto(smartHrUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
}
```

**Strategy B -- Menu navigation (fallback):**
```typescript
// PeopleSoft wraps content in iframe #ptifrmtgtframe
// Homepage tiles are OUTSIDE the iframe (in the main page or Fluid wrapper)
// After clicking a tile/menu, content loads INSIDE the iframe
async function navigateViaMenu(page: Page): Promise<void> {
  log.step("Navigating to HR Tasks...");

  // SELECTOR: Homepage tile for HR Tasks -- may be a tile, NavBar item, or menu link
  // PeopleSoft Fluid homepage uses tiles with role="link" or class="ps_grid-flex"
  const hrTasksTile = page.getByRole("link", { name: /HR Tasks/i })
    .or(page.getByText("HR Tasks"));
  await hrTasksTile.first().click({ timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  // SELECTOR: Smart HR Templates dropdown/menu item
  log.step("Opening Smart HR Templates...");
  const smartHrMenu = page.getByText("Smart HR Templates")
    .or(page.getByRole("link", { name: /Smart HR Template/i }));
  await smartHrMenu.first().click({ timeout: 10_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  // SELECTOR: Smart HR Transactions link within the dropdown
  log.step("Selecting Smart HR Transactions...");
  const transactionsLink = page.getByText("Smart HR Transactions")
    .or(page.getByRole("link", { name: /Smart HR Transactions/i }));
  await transactionsLink.first().click({ timeout: 10_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });
}
```

### Pattern 2: PeopleSoft Iframe Handling
**What:** PeopleSoft wraps all Classic/Classic Plus page content in an iframe with id `ptifrmtgtframe` (name `TargetContent`). All form interactions after navigation must target this iframe.
**When to use:** Every interaction with PeopleSoft form elements (dropdowns, inputs, buttons) after the initial homepage/menu navigation.
**Example:**
```typescript
// Source: PeopleSoft standard iframe structure + Playwright frameLocator API
import type { Page, FrameLocator } from "playwright";

function getContentFrame(page: Page): FrameLocator {
  // PeopleSoft standard content iframe
  // SELECTOR: ptifrmtgtframe is the standard PeopleSoft iframe ID
  return page.frameLocator("#ptifrmtgtframe");
}

// Usage: all form interactions go through the frame
const frame = getContentFrame(page);
await frame.getByRole("button", { name: "Create Transaction" }).click();
```

### Pattern 3: Template Selection (ENTR-02)
**What:** Select UC_FULL_HIRE from the template dropdown on the Smart HR Transactions page.
**When to use:** After navigating to the Smart HR Transactions page.
**Key insight:** PeopleSoft dropdowns can be native `<select>` elements OR custom JavaScript-driven lookups. If native, use `selectOption()`. If custom (search/lookup dialog), requires clicking the lookup icon, searching, and selecting.
**Example:**
```typescript
// Source: Oracle PeopleSoft Smart HR docs (HR_TBH_EULIST page)
async function selectTemplate(
  frame: FrameLocator,
  templateId: string, // e.g., "UC_FULL_HIRE"
): Promise<void> {
  log.step(`Selecting template: ${templateId}...`);

  // SELECTOR: Template dropdown -- may be <select> or PeopleSoft lookup field
  // Strategy 1: Native <select> element
  const templateSelect = frame.locator("select").filter({ hasText: /template/i })
    .or(frame.getByLabel(/template/i));

  try {
    await templateSelect.first().selectOption({ label: templateId }, { timeout: 5_000 });
  } catch {
    // Strategy 2: PeopleSoft lookup -- click the lookup icon, search, select
    log.step("Trying lookup-based template selection...");
    // SELECTOR: to be discovered during live testing
  }
}
```

### Pattern 4: Date Input with PeopleSoft Tab (ENTR-03)
**What:** Enter the effective date into the date field and press Tab to trigger PeopleSoft server validation.
**When to use:** After template selection, before clicking Create Transaction.
**Key insight:** PeopleSoft requires a Tab keypress after filling a field to trigger server-side validation. The page may show a spinner during validation. Wait for the spinner to disappear before proceeding.
**Example:**
```typescript
// Source: selenium-peoplesoft patterns adapted for Playwright
async function enterEffectiveDate(
  frame: FrameLocator,
  date: string, // MM/DD/YYYY format (from EmployeeData.effectiveDate)
): Promise<void> {
  log.step("Entering effective date...");

  // SELECTOR: Date field -- may have id like "DERIVED_HR_TBH_EFFDT" or similar
  const dateField = frame.getByLabel(/effective date/i)
    .or(frame.getByLabel(/job effective date/i))
    .or(frame.locator('input[id*="EFFDT"]'));

  await dateField.first().fill(date, { timeout: 5_000 });

  // PeopleSoft requires Tab to trigger server validation
  await dateField.first().press("Tab");

  // Wait for any PeopleSoft spinner/processing to complete
  // SELECTOR: PeopleSoft processing indicator -- adjust after live testing
  try {
    await frame.locator("#processing, .ps_box-processing")
      .waitFor({ state: "hidden", timeout: 10_000 });
  } catch {
    // No spinner appeared -- that is fine
  }
}
```

### Pattern 5: Transaction Creation (ENTR-04)
**What:** Click the "Create Transaction" button and detect the confirmation or error response.
**When to use:** After template and date are set, in non-dry-run mode only.
**Example:**
```typescript
// Source: Oracle PeopleSoft Smart HR docs
async function clickCreateTransaction(
  frame: FrameLocator,
): Promise<TransactionResult> {
  log.step("Clicking Create Transaction...");

  // SELECTOR: Create Transaction button
  const createBtn = frame.getByRole("button", { name: /create transaction/i })
    .or(frame.locator('input[value="Create Transaction"]'))
    .or(frame.getByText("Create Transaction"));

  await createBtn.first().click({ timeout: 10_000 });

  // Wait for page response -- PeopleSoft will either:
  // 1. Navigate to Enter Transaction Details page (HR_TBH_ADD) -- success
  // 2. Show an error message -- failure
  // 3. Show a confirmation dialog -- needs acknowledgment
  await frame.locator("body").waitFor({ state: "attached", timeout: 30_000 });

  // SELECTOR: Success/error detection -- to be discovered during live testing
  // Check for error messages
  const errorMsg = frame.locator(".PSERROR, #ALERTMSG, .ps_alert-error");
  const hasError = await errorMsg.count().catch(() => 0);

  if (hasError > 0) {
    const errorText = await errorMsg.first().textContent();
    return { success: false, error: errorText?.trim() ?? "Unknown error" };
  }

  return { success: true };
}
```

### Pattern 6: Dry-Run Engine (ENTR-05)
**What:** Build an action plan that describes every step the automation would take, then either preview it (dry-run) or execute it (live). The action plan is an ordered list of `{ description, execute }` pairs.
**When to use:** Wraps the entire transaction entry workflow. The CLI `--dry-run` flag determines whether actions are previewed or executed.
**Key insight:** UCPath transactions cannot be undone. Dry-run mode must NEVER navigate to UCPath or interact with any UCPath page. It should only display the extracted data and the list of intended actions.
**Example:**
```typescript
// Source: action plan pattern for destructive operations
interface PlannedAction {
  step: number;
  description: string;
  execute: () => Promise<void>;
}

class ActionPlan {
  private actions: PlannedAction[] = [];
  private stepCounter = 0;

  add(description: string, execute: () => Promise<void>): void {
    this.stepCounter++;
    this.actions.push({ step: this.stepCounter, description, execute });
  }

  preview(): void {
    log.step("=== DRY RUN: Transaction Preview ===");
    for (const action of this.actions) {
      log.step(`  ${action.step}. ${action.description}`);
    }
    log.step("=== No changes made to UCPath ===");
  }

  async execute(): Promise<void> {
    for (const action of this.actions) {
      log.step(`[${action.step}/${this.actions.length}] ${action.description}`);
      await action.execute();
    }
  }
}

// Usage in workflow:
function buildTransactionPlan(
  data: EmployeeData,
  page: Page,
): ActionPlan {
  const plan = new ActionPlan();

  plan.add(
    "Navigate to Smart HR Transactions",
    () => navigateToSmartHR(page),
  );
  plan.add(
    "Select template UC_FULL_HIRE",
    () => selectTemplate(getContentFrame(page), "UC_FULL_HIRE"),
  );
  plan.add(
    `Enter effective date: ${data.effectiveDate}`,
    () => enterEffectiveDate(getContentFrame(page), data.effectiveDate),
  );
  plan.add(
    "Click Create Transaction",
    () => clickCreateTransaction(getContentFrame(page)),
  );

  return plan;
}

// CLI integration:
if (dryRun) {
  log.step("Employee data to be used:");
  // Print non-PII summary (field names + counts, not values)
  log.step(`  Fields: ${Object.keys(data).length}`);
  log.step(`  Effective date: ${data.effectiveDate}`);
  plan.preview();
} else {
  await plan.execute();
}
```

### Pattern 7: Transaction Result Types
**What:** Typed result for transaction creation outcome.
**When to use:** Return value from the transaction entry workflow.
**Example:**
```typescript
// src/ucpath/types.ts
export interface TransactionResult {
  success: boolean;
  error?: string;
  transactionId?: string; // if discoverable from confirmation page
}

export class TransactionError extends Error {
  constructor(
    message: string,
    public readonly step?: string,
  ) {
    super(message);
    this.name = "TransactionError";
  }
}
```

### Anti-Patterns to Avoid
- **Do NOT interact with UCPath in dry-run mode:** Dry-run must NEVER navigate to UCPath, open a browser for UCPath, or touch any PeopleSoft page. It is purely a console preview of intended actions plus data display.
- **Do NOT use `page.waitForTimeout()` for PeopleSoft spinners:** Use explicit waits for spinner visibility changes. PeopleSoft spinners have varying durations; hard sleeps will be either too short (causing failures) or too long (wasting time).
- **Do NOT use exact element IDs for PeopleSoft:** PeopleSoft generates dynamic IDs with session-specific suffixes. Use partial ID matches (`[id*="KEYWORD"]`), text-based locators, or role-based locators.
- **Do NOT skip the Tab key after filling PeopleSoft fields:** PeopleSoft uses the Tab/blur event to trigger server-side validation. Without Tab, the field value may not register with the server, causing downstream errors.
- **Do NOT log PII in dry-run output:** The effective date is safe to display (it is a date, not PII). However, never log SSN, names, addresses, or other employee data in dry-run output. Log field counts and the effective date only.
- **Do NOT close the browser after transaction creation:** Per user requirement (`feedback_no_session_tracking.md`), leave the browser open after work is done.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PeopleSoft iframe access | Manual `page.evaluate()` with `document.getElementById('ptifrmtgtframe')` | Playwright `page.frameLocator('#ptifrmtgtframe')` | Auto-wait, proper element scoping, type-safe locators |
| Dropdown selection | Manual click + option search | Playwright `selectOption()` for native selects | Handles async rendering, auto-wait for options |
| Date formatting | Custom date parser | Direct string pass-through | Phase 2 Zod schema already validates MM/DD/YYYY format |
| CLI flags | Manual `process.argv` parsing | Commander `.option("--dry-run")` | Already in project; handles help text, validation |
| Action plan / dry-run | Scattered if/else checks | Centralized ActionPlan class | Single place to preview vs execute; cleaner audit trail |

**Key insight:** The only genuinely new code in this phase is (1) PeopleSoft navigation selectors (which require live discovery) and (2) the action plan dry-run engine. Everything else uses existing Playwright APIs and project patterns.

## Common Pitfalls

### Pitfall 1: PeopleSoft Content Iframe
**What goes wrong:** Selectors that target elements visible on screen fail because the elements are inside the `#ptifrmtgtframe` iframe, not the main page.
**Why it happens:** PeopleSoft wraps all Classic/Classic Plus page content in an iframe. The main page DOM only contains the Fluid navigation shell (banner, NavBar, homepage tiles). After navigating to a transaction page, all form elements live inside the iframe.
**How to avoid:** After navigating to the Smart HR Transactions page, immediately switch to `page.frameLocator('#ptifrmtgtframe')` for all subsequent interactions. Create a helper function `getContentFrame(page)` and use it consistently.
**Warning signs:** "Element not found" errors for elements that are clearly visible in the browser.

### Pitfall 2: Tab Key Requirement for PeopleSoft Fields
**What goes wrong:** Effective date is filled in the field but PeopleSoft does not register the value. The Create Transaction button fails or uses a wrong/empty date.
**Why it happens:** PeopleSoft uses JavaScript blur/change handlers tied to the Tab key. When a user types in a field and tabs out, PeopleSoft makes a server call to validate the value and update dependent fields. `fill()` alone does not trigger this.
**How to avoid:** After every `fill()` on a PeopleSoft field, immediately follow with `.press("Tab")`. Then wait for any processing spinner to disappear before proceeding to the next action.
**Warning signs:** Fields appear filled but the server rejects or ignores the value.

### Pitfall 3: PeopleSoft Dynamic Element IDs
**What goes wrong:** Selectors with exact IDs like `#ICMyID_123` work once but fail on next run.
**Why it happens:** PeopleSoft regenerates numeric suffixes in element IDs per session. The base keyword remains stable but the suffix changes.
**How to avoid:** Use partial ID matches (`[id*="KEYWORD"]`), text-based locators (`getByText`), role-based locators (`getByRole`), or label-based locators (`getByLabel`). When using attribute selectors, match the stable keyword portion only.
**Warning signs:** Tests pass on first run, fail on second run with "element not found."

### Pitfall 4: PeopleSoft Navigation Timing
**What goes wrong:** Code clicks a menu item but PeopleSoft has not finished loading the previous page, causing the click to be lost or a stale element error.
**Why it happens:** PeopleSoft pages make multiple server round-trips during navigation. The DOM updates asynchronously, and clicking too early can hit a transitional state.
**How to avoid:** After each navigation click, wait for `networkidle` OR wait for a specific element on the target page to appear. Use generous timeouts (15-30 seconds) for PeopleSoft navigation -- it is inherently slow.
**Warning signs:** Intermittent "element detached from DOM" or "navigation failed" errors.

### Pitfall 5: Dry-Run Mode Accidentally Touching UCPath
**What goes wrong:** Dry-run mode navigates to UCPath "just to show the page" and accidentally triggers a state change, or the user sees a half-started transaction.
**Why it happens:** Developer tries to make dry-run more realistic by navigating to the actual page and stopping before the final click.
**How to avoid:** Dry-run mode must be a strict console-only operation. It builds the action plan from the extracted data (which is already validated and in memory), prints the plan steps, and exits. No browser navigation to UCPath occurs in dry-run. The browser is only launched for UCPath in live mode.
**Warning signs:** Dry-run output mentions "Navigating to..." or any actual page load activity.

### Pitfall 6: Separate Browser Contexts
**What goes wrong:** Code tries to use the ACT CRM browser session to access UCPath.
**Why it happens:** Phase 2's extract command uses a browser authenticated to ACT CRM. Phase 3 needs a browser authenticated to UCPath. These are separate systems with separate auth.
**How to avoid:** Per `feedback_auth_architecture.md`, UCPath and ACT CRM never share sessions. The create-transaction command must: (1) launch a browser and authenticate to ACT CRM for extraction, (2) launch a SEPARATE browser and authenticate to UCPath for transaction entry. Or, in the simpler v1 approach, run extract first (Phase 2 command), then run create-transaction with the extracted data passed in memory or re-extracted.
**Warning signs:** UCPath navigation redirects to SSO login despite having a "valid session."

## Code Examples

### CLI Command: create-transaction
```typescript
// Addition to src/cli.ts
// Source: commander + existing CLI patterns
program
  .command("create-transaction")
  .description("Create a UC_FULL_HIRE transaction in UCPath")
  .argument("<email>", "Employee email to extract data for")
  .option("--dry-run", "Preview actions without creating transaction")
  .action(async (email: string, options: { dryRun?: boolean }) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    const dryRun = options.dryRun ?? false;

    // Step 1: Extract employee data from ACT CRM
    // (same flow as extract command)
    const data = await extractEmployeeData(email);

    // Step 2: Build action plan
    const plan = buildTransactionPlan(data);

    if (dryRun) {
      // Dry-run: print data summary + action plan
      log.step("=== DRY RUN MODE ===");
      log.step(`Employee: [PII REDACTED]`);
      log.step(`Effective date: ${data.effectiveDate}`);
      log.step(`Fields validated: ${Object.keys(data).length}`);
      plan.preview();
      log.success("Dry run complete -- no changes made to UCPath");
      return;
    }

    // Step 3: Live mode -- authenticate to UCPath and execute
    log.step("Starting UCPath transaction entry...");
    const { browser, page } = await launchBrowser();
    try {
      const authOk = await loginToUCPath(page);
      if (!authOk) {
        log.error("UCPath authentication failed");
        process.exit(1);
      }

      await plan.execute(page);
      log.success("Transaction created successfully");
    } catch (error) {
      if (error instanceof TransactionError) {
        log.error(`Transaction failed at step: ${error.step}`);
        log.error(error.message);
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`Transaction failed: ${msg}`);
      }
      process.exit(1);
    }
    // Browser left open per user requirement
  });
```

### PeopleSoft Iframe Helper
```typescript
// src/ucpath/navigate.ts
import type { Page, FrameLocator } from "playwright";
import { log } from "../utils/log.js";

/**
 * Get the PeopleSoft content iframe.
 * All Classic/Classic Plus page content lives inside this iframe.
 *
 * SELECTOR: #ptifrmtgtframe is the standard PeopleSoft content iframe ID.
 */
export function getContentFrame(page: Page): FrameLocator {
  return page.frameLocator("#ptifrmtgtframe");
}

/**
 * Wait for PeopleSoft to finish processing after a field change or click.
 * PeopleSoft shows a spinner during server round-trips.
 */
export async function waitForPeopleSoftProcessing(
  frame: FrameLocator,
  timeoutMs: number = 10_000,
): Promise<void> {
  try {
    // SELECTOR: PeopleSoft processing/spinner indicators -- adjust after live testing
    const spinner = frame.locator(
      "#processing, #WAIT_win0, .ps_box-processing, [id*='PROCESSING']",
    );
    // Wait for spinner to appear then disappear, or timeout if it never appears
    await spinner.first().waitFor({ state: "visible", timeout: 2_000 }).catch(() => {});
    await spinner.first().waitFor({ state: "hidden", timeout: timeoutMs }).catch(() => {});
  } catch {
    // No spinner -- proceed
  }
}
```

### npm Script
```json
{
  "create-transaction": "tsx --env-file=.env src/cli.ts create-transaction",
  "create-transaction:dry": "tsx --env-file=.env src/cli.ts create-transaction --dry-run"
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| PeopleSoft Classic UI (pre-Fluid) | Fluid UI with Classic Plus wrapping | PeopleTools 8.55+ (2016) | All content in `#ptifrmtgtframe` iframe; homepage tiles for navigation |
| `page.frame()` by name | `page.frameLocator()` | Playwright v1.17+ | Simpler API, auto-wait, chainable locators |
| `waitForNavigation()` | `waitForURL()` | Playwright v1.20+ | No race conditions (established in Phase 1) |
| Manual dry-run if/else | Action plan pattern | Best practice | Centralized preview + execution; cleaner audit trail |
| PeopleTools 8.59 NavBar | Navigator renamed to Menu | PeopleTools 8.59 (2024) | Navigation icons changed but menu structure remains |

**Deprecated/outdated:**
- `page.frame({ name: "TargetContent" })`: Still works but `frameLocator()` is preferred for auto-wait behavior
- `waitForNavigation()`: Deprecated in Playwright; use `waitForURL()` (established in Phase 1)
- PeopleSoft Classic-only UI: UC systems have moved to Fluid/Classic Plus; expect iframe wrapping

## Open Questions

1. **Smart HR Transactions Page URL**
   - What we know: The PeopleSoft component is `HR_TBH_EULIST`. PeopleSoft URLs follow `/psc/<instance>/EMPLOYEE/<node>/c/<MENU>.<COMPONENT>.GBL` pattern. Navigation path is Homepage > HR Tasks > Smart HR Templates > Smart HR Transactions.
   - What is unclear: The exact URL for UCPath's Smart HR Transactions page (instance name, node name). Whether direct URL navigation bypasses the menu successfully.
   - Recommendation: During live testing, observe the URL after navigating to the Smart HR Transactions page. If a stable URL is found, switch to direct `page.goto()` navigation per the established URL-param pattern from Phase 2.

2. **UC_FULL_HIRE Template Selector**
   - What we know: Smart HR Transactions page has a template dropdown. The template is named UC_FULL_HIRE (UC-specific customization of PeopleSoft Smart HR Templates).
   - What is unclear: Whether the template selector is a native `<select>`, a PeopleSoft lookup field, or a custom dropdown. Whether there is also a "Transaction Type" filter that must be set first.
   - Recommendation: During live testing, inspect the template selector DOM. Try `selectOption()` first; if it fails, fall back to lookup-based selection. Document the working approach.

3. **Effective Date Field ID**
   - What we know: The Enter Transaction Details page (HR_TBH_ADD) has a "Job Effective Date" field. PeopleSoft date fields typically have IDs containing "EFFDT".
   - What is unclear: The exact field ID in UCPath's implementation. Whether the date field requires a specific format or accepts the MM/DD/YYYY format from our Zod schema.
   - Recommendation: During live testing, inspect the date field. The Zod schema already enforces MM/DD/YYYY which is the standard PeopleSoft date format for US locale.

4. **Create Transaction Confirmation**
   - What we know: After clicking Create Transaction, PeopleSoft either navigates to the Enter Transaction Details page (success) or shows an error. The confirmation page definition is `HR_TBH_CONFIRM`.
   - What is unclear: What UCPath specifically shows after transaction creation. Whether there is a transaction ID displayed. What error messages look like.
   - Recommendation: During live testing, create a test transaction and observe the response. Document the success indicator and error patterns.

5. **Homepage Navigation Structure**
   - What we know: PeopleSoft Fluid homepage uses tiles. UCPath UCSD navigation path includes "HR Tasks" as a tile or menu item.
   - What is unclear: Whether "HR Tasks" is a homepage tile, a NavBar item, or a navigation collection. Whether the Smart HR Templates item is a sub-menu or a dropdown within the tile landing page.
   - Recommendation: Live testing is required. Try tile-based navigation first. Document the exact click sequence.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node.js built-in test runner (node:test) + TypeScript (tsc --noEmit) |
| Config file | tsconfig.test.json (extends base tsconfig, rootDir `.` for combined src + tests) |
| Quick run command | `npm test` |
| Full suite command | `npm test && npm run typecheck:all` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ENTR-01 | Navigate UCPath to Smart HR Transactions | smoke (manual) | Manual: `npm run create-transaction <email>` -- verify navigation to Smart HR page | N/A -- manual only |
| ENTR-02 | Select UC_FULL_HIRE template | smoke (manual) | Manual: `npm run create-transaction <email>` -- verify template selected | N/A -- manual only |
| ENTR-03 | Enter effective date | smoke (manual) | Manual: `npm run create-transaction <email>` -- verify date entered | N/A -- manual only |
| ENTR-04 | Click Create Transaction | smoke (manual) | Manual: `npm run create-transaction <email>` -- verify transaction created | N/A -- manual only |
| ENTR-05 | Dry-run mode previews without submitting | unit + manual | `npm test` (ActionPlan unit tests) + manual `npm run create-transaction:dry <email>` | No -- Wave 0 |
| -- | ActionPlan preview lists all steps | unit | `npm test` (tests/unit/action-plan.test.ts) | No -- Wave 0 |
| -- | ActionPlan execute runs all steps in order | unit | `npm test` (tests/unit/action-plan.test.ts) | No -- Wave 0 |
| -- | TransactionError carries step context | unit | `npm test` (tests/unit/transaction-types.test.ts) | No -- Wave 0 |
| -- | TypeScript compiles | unit | `npm run typecheck:all` | Existing |

### Sampling Rate
- **Per task commit:** `npm run typecheck:all` (type checking) + `npm test` (all unit tests)
- **Per wave merge:** Full test suite + manual `npm run create-transaction:dry <email>` + manual `npm run create-transaction <email>` (live)
- **Phase gate:** (1) Dry-run shows correct action plan with extracted data, (2) Live run navigates UCPath, selects template, enters date, clicks Create Transaction, (3) Confirmation or specific error reported

### Wave 0 Gaps
- [ ] `tests/unit/action-plan.test.ts` -- unit tests for ActionPlan (preview output, execute order, step numbering)
- [ ] `tests/unit/transaction-types.test.ts` -- unit tests for TransactionError, TransactionResult types
- [ ] `package.json` scripts -- add `create-transaction` and `create-transaction:dry` scripts

**Note:** ENTR-01 through ENTR-04 are inherently manual-only because they require a live authenticated UCPath browser session with Duo MFA. The unit-testable surface is ENTR-05 (dry-run ActionPlan logic) and the type definitions. The phase gate requires a successful live transaction creation run.

## Sources

### Primary (HIGH confidence)
- [Oracle PeopleSoft Smart HR Transactions Docs](https://docs.oracle.com/cd/F13810_02/hcm92pbr29/eng/hcm/hhaw/task_UsingSmartHRTemplatesAndTransactions.html) - Complete page definitions, workflow, UI elements, form fields, confirmation/error handling
- [Oracle PeopleSoft Smart HR Template Setup](https://docs.oracle.com/cd/F13810_02/hcm92pbr29/eng/hcm/hhaw/task_SettingUpSmartHRTemplates.html) - Template configuration, section structure, field controls, transaction types
- [Playwright FrameLocator API](https://playwright.dev/docs/api/class-framelocator) - frameLocator(), getByRole(), getByText(), locator() within frames
- [Playwright Input Actions](https://playwright.dev/docs/input) - fill(), selectOption(), press(), click() for form interaction
- [Oracle PeopleSoft Fluid UX Navigation](https://docs.oracle.com/cd/E65859_01/fluid_ux/navigation.html) - Homepage tiles, NavBar, Navigator, navigation patterns

### Secondary (MEDIUM confidence)
- [PeopleSoft URL Navigation](https://peoplesofttips4u.blogspot.com/2013/05/direct-url-of-page-in-peoplesoft.html) - psp/psc URL structure for direct component access
- [PeopleSoft Selenium Automation](https://github.com/tbensky/selenium-peoplesoft) - Tab key requirement, spinner waiting, fill patterns adapted for Playwright
- [UCSB Smart HR Template Transactions](https://www.hr.ucsb.edu/hr-units/workforce-administration/wfa-smart-hr-template-transactions) - UC-specific navigation path confirmation (Homepage > HR Tasks > Smart HR Templates)
- [UCPath UCSD Navigation Quick Reference](https://ucpath.ucsd.edu/_files/training/QR-UCPath-System-Navigation.pdf) - UCSD-specific menu paths
- [Dry-Run Engineering Patterns](https://dev.to/danieljglover/dry-run-engineering-the-simple-practice-that-prevents-production-disasters-ek0) - Action plan pattern, flag-based gating, preview vs execute separation
- [Kovaion PeopleSoft Smart HR Templates](https://www.kovaion.com/blog/peoplesoft-smart-hr-templates/) - Template overview, navigation confirmation

### Tertiary (LOW confidence)
- UCPath UCSD Smart HR Transactions page DOM structure -- requires authenticated live session to inspect
- UC_FULL_HIRE template dropdown type (native select vs lookup) -- requires live inspection
- PeopleSoft processing spinner selector -- requires live observation
- Homepage tile/menu exact structure at UCSD -- requires live navigation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new dependencies; all patterns use existing Playwright + Commander
- Architecture: HIGH - Action plan pattern is well-established; PeopleSoft iframe pattern is documented
- Dry-run design: HIGH - Simple flag-based gating with action plan; no novel patterns
- PeopleSoft navigation: MEDIUM - Menu structure confirmed by UC docs; exact selectors require live testing
- PeopleSoft selectors: LOW - All selectors are best-guess placeholders; PeopleSoft dynamic IDs and iframe structure require live discovery (same pattern as Phases 1 and 2)

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (30 days -- Playwright stable; PeopleSoft selectors are the volatile element)
