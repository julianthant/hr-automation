# Phase 2: Data Extraction from ACT CRM - Research

**Researched:** 2026-03-13
**Domain:** Playwright DOM extraction, Salesforce Experience Cloud navigation, Zod schema validation
**Confidence:** HIGH (stack/patterns) / MEDIUM (ACT CRM selectors -- require live discovery)

## Summary

Phase 2 builds on the authenticated browser sessions from Phase 1 to search ACT CRM by employee email, navigate to the UCPath Entry Sheet, and extract structured onboarding data. The technical challenge has three parts: (1) interacting with search/navigation UI on a Salesforce Experience Cloud site (shadow DOM, dynamic rendering), (2) extracting text values from a form/sheet page, and (3) validating the extracted data against a strict Zod schema before passing it downstream.

The existing codebase already provides Playwright browser launch, session persistence, and the ACT CRM authentication flow. Phase 2 adds a new `src/extraction/` module that receives an authenticated Playwright Page, performs the search-navigate-extract workflow, and returns validated data or a typed error. Zod 4 (current stable: ^4.3.6) is the only new dependency -- it provides `safeParse` with structured error formatting that maps cleanly to the requirement for "clear error message identifying the failing fields."

The key unknown remains ACT CRM's DOM structure. Salesforce Experience Cloud uses Lightning Web Components with shadow DOM, but Playwright CSS/text locators pierce shadow boundaries by default. The selectors will need live discovery and adjustment, following the same pattern established in Phase 1 (where 6 of 7 deviations were selector fixes found during live testing).

**Primary recommendation:** Add Zod 4 as the only new dependency. Build extraction as a pure function pipeline: search -> navigate -> extract raw strings -> validate with Zod -> return typed result or structured error. Treat all selectors as best-guess placeholders that will be corrected during a live verification step.

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| EXTR-01 | Automation searches ACT CRM onboarding portal by employee email address | Playwright `page.fill()` + `page.click()` for search input interaction -- see Architecture Patterns "Search Flow" |
| EXTR-02 | Automation selects the search result row with the latest date | Playwright table row extraction + date comparison -- see Architecture Patterns "Result Selection" |
| EXTR-03 | Automation navigates to employee profile and clicks UCPath Entry Sheet | Playwright click + waitForURL/waitForSelector navigation -- see Architecture Patterns "Navigation Flow" |
| EXTR-04 | Automation extracts position number, first name, last name, SSN, address, city, state, postal code, wage, and effective date from UCPath Entry Sheet | Playwright `textContent()`/`innerText()` + `evaluate()` extraction -- see Code Examples |
| EXTR-05 | Extracted data passes Zod schema validation before proceeding (rejects incomplete or malformed data) | Zod 4 `safeParse` + `z.prettifyError()` -- see Standard Stack and Code Examples |

</phase_requirements>

## Standard Stack

### Core (existing -- no changes)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| playwright | ^1.58.2 | Browser automation and DOM extraction | Already installed; provides locators, text extraction, shadow DOM piercing |
| typescript | ^5.9.3 | Type safety | Already installed; Zod infers types from schemas |
| tsx | ^4.21.0 | TypeScript execution | Already installed; zero-config runner |
| commander | ^14.0.3 | CLI argument parsing | Already installed; will add extract subcommand |
| picocolors | ^1.1.1 | Terminal colors | Already installed; extraction step/error output |

### New Dependency
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | ^4.3.6 | Schema validation with type inference | Industry standard for TypeScript validation; `safeParse` returns structured errors with field paths; `z.prettifyError()` produces human-readable failure messages; 10x faster compilation than v3; 57% smaller bundle |

### Not Needed
| Problem | Skip This | Use Instead | Why |
|---------|-----------|-------------|-----|
| HTML parsing | cheerio / jsdom | Playwright locators + textContent() | Playwright already has the DOM loaded; no need for a separate parser |
| Date parsing | date-fns / dayjs / moment | Native Date constructor or string comparison | Only need to compare dates and validate format, not complex date math |
| Data transformation | lodash / ramda | Plain functions | Extraction is simple field-by-field text retrieval |

**Installation:**
```bash
npm install zod@^4
```

## Architecture Patterns

### Recommended Project Structure (additions to existing)
```
src/
├── auth/               # (existing) Authentication flows
├── browser/            # (existing) Browser launch
├── extraction/
│   ├── search.ts       # EXTR-01, EXTR-02: Search ACT CRM + select latest row
│   ├── navigate.ts     # EXTR-03: Navigate to UCPath Entry Sheet
│   ├── extract.ts      # EXTR-04: Extract field values from entry sheet
│   ├── schema.ts       # EXTR-05: Zod schema + validation
│   └── types.ts        # EmployeeData interface (inferred from Zod schema)
├── cli.ts              # (existing) Add extract-employee command
└── utils/              # (existing) Logger, env validation
```

### Pattern 1: Search Flow (EXTR-01)
**What:** Navigate to ACT CRM search, enter employee email, submit search.
**When to use:** Entry point for every employee extraction.
**Example:**
```typescript
// Source: Playwright fill() + click() from official docs
import type { Page } from "playwright";

export async function searchByEmail(page: Page, email: string): Promise<void> {
  // Navigate to onboarding portal search
  // SELECTOR: may need adjustment after live testing
  await page.goto("https://act-crm.my.site.com/hr/a1Z/o", {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });

  // Find search input and enter email
  // SELECTOR: Salesforce Experience Cloud -- likely a Lightning input component
  const searchInput = page.getByPlaceholder("Search").or(
    page.getByRole("searchbox"),
  ).or(
    page.locator('input[type="search"]'),
  );
  await searchInput.first().fill(email, { timeout: 10_000 });

  // Submit search (press Enter or click search button)
  await searchInput.first().press("Enter");

  // Wait for results to load
  await page.waitForLoadState("networkidle", { timeout: 15_000 });
}
```

### Pattern 2: Result Selection with Latest Date (EXTR-02)
**What:** From search results table/list, identify the row with the most recent date and click it.
**When to use:** After search returns results, before navigating to profile.
**Example:**
```typescript
// Source: Playwright locator pattern for table rows
export async function selectLatestResult(page: Page): Promise<void> {
  // Wait for results table to be present
  // SELECTOR: may need adjustment after live testing
  const rows = page.locator("table tbody tr").or(
    page.locator('[role="row"]'),
  );

  const count = await rows.count();
  if (count === 0) {
    throw new ExtractionError("No search results found");
  }

  // Extract dates from each row to find the latest
  // SELECTOR: date column position may vary -- adjust after live testing
  let latestIndex = 0;
  let latestDate = new Date(0);

  for (let i = 0; i < count; i++) {
    const dateCell = rows.nth(i).locator("td").last(); // date column -- adjust
    const dateText = await dateCell.textContent();
    if (dateText) {
      const parsed = new Date(dateText.trim());
      if (!isNaN(parsed.getTime()) && parsed > latestDate) {
        latestDate = parsed;
        latestIndex = i;
      }
    }
  }

  // Click the row with the latest date
  await rows.nth(latestIndex).click();
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
}
```

### Pattern 3: Navigation to UCPath Entry Sheet (EXTR-03)
**What:** From the employee profile/record page, click the UCPath Entry Sheet link/tab.
**When to use:** After selecting a search result, before extraction.
**Example:**
```typescript
// Source: Playwright navigation + waitForURL
export async function navigateToEntrySheet(page: Page): Promise<void> {
  // SELECTOR: may need adjustment after live testing
  // Look for "UCPath Entry Sheet" as link text, tab label, or button
  const entrySheetLink = page.getByRole("link", {
    name: /UCPath Entry Sheet/i,
  }).or(
    page.getByText("UCPath Entry Sheet"),
  ).or(
    page.getByRole("tab", { name: /UCPath Entry Sheet/i }),
  );

  await entrySheetLink.first().click({ timeout: 10_000 });

  // Wait for the entry sheet page/section to load
  await page.waitForLoadState("networkidle", { timeout: 15_000 });
}
```

### Pattern 4: Field Extraction with Fallback Strategies (EXTR-04)
**What:** Extract individual field values from the entry sheet page using multiple selector strategies.
**When to use:** On the UCPath Entry Sheet page after navigation.
**Key insight:** Salesforce pages render field values in various ways -- sometimes as `<span>` inside a `<lightning-formatted-text>`, sometimes as table cells next to labels, sometimes in custom components. Use label-based lookup with fallbacks.
**Example:**
```typescript
// Source: Playwright textContent() + locator chaining
async function extractField(page: Page, label: string): Promise<string | null> {
  // Strategy 1: Label + adjacent/sibling value element
  // SELECTOR: Salesforce may use dt/dd, th/td, or label/span pairs
  const byLabel = page.locator(`text="${label}"`).locator("xpath=..").locator("span, dd, td").last();

  // Strategy 2: ARIA label association
  const byAria = page.getByLabel(label);

  // Strategy 3: Table cell lookup (label in one cell, value in next)
  const byTableCell = page.locator(`td:has-text("${label}")`).locator("xpath=following-sibling::td[1]");

  // Try each strategy
  for (const locator of [byLabel, byAria, byTableCell]) {
    try {
      const text = await locator.first().textContent({ timeout: 3_000 });
      if (text && text.trim()) return text.trim();
    } catch {
      continue;
    }
  }

  return null;
}
```

### Pattern 5: Zod Schema Validation with Human-Readable Errors (EXTR-05)
**What:** Validate extracted raw data against a strict schema. On failure, produce a message listing which fields failed and why.
**When to use:** After all fields are extracted, before returning data to caller.
**Example:**
```typescript
// Source: https://zod.dev/basics, https://zod.dev/error-formatting
import { z } from "zod";

const EmployeeDataSchema = z.object({
  positionNumber: z.string().min(1, "Position number is required"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  ssn: z.string().regex(
    /^\d{3}-\d{2}-\d{4}$/,
    "SSN must be in XXX-XX-XXXX format",
  ),
  address: z.string().min(1, "Address is required"),
  city: z.string().min(1, "City is required"),
  state: z.string().length(2, "State must be 2-letter code"),
  postalCode: z.string().regex(
    /^\d{5}(-\d{4})?$/,
    "Postal code must be XXXXX or XXXXX-XXXX format",
  ),
  wage: z.string().min(1, "Wage is required"),
  effectiveDate: z.string().regex(
    /^\d{2}\/\d{2}\/\d{4}$|^\d{4}-\d{2}-\d{2}$/,
    "Effective date must be MM/DD/YYYY or YYYY-MM-DD format",
  ),
});

type EmployeeData = z.infer<typeof EmployeeDataSchema>;

function validateExtractedData(raw: Record<string, string | null>): EmployeeData {
  const result = EmployeeDataSchema.safeParse(raw);
  if (!result.success) {
    // z.prettifyError produces human-readable output with field paths
    const message = z.prettifyError(result.error);
    throw new ExtractionError(`Data validation failed:\n${message}`);
  }
  return result.data;
}
```

### Pattern 6: Extraction Error Type
**What:** Custom error class for extraction failures, distinct from auth errors.
**When to use:** Any failure during the search-navigate-extract pipeline.
**Example:**
```typescript
export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly failedFields?: string[],
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}
```

### Anti-Patterns to Avoid
- **Do NOT use page.evaluate() for simple text extraction:** Use `locator.textContent()` or `locator.innerText()` -- they are simpler, auto-wait, and do not require serializing functions into the browser context. Reserve `evaluate()` for batch extraction where performance matters.
- **Do NOT hardcode selectors before live discovery:** ACT CRM is Salesforce Experience Cloud with dynamic Lightning components. Follow the Phase 1 precedent: write best-guess selectors, mark them with `// SELECTOR: may need adjustment`, and plan a live verification step.
- **Do NOT log extracted PII values:** Continue the PII-safe logging pattern from Phase 1. Log step names ("Extracting SSN field...") not values ("SSN: 123-45-6789").
- **Do NOT store extracted data to disk:** Per project constraints, data flows through memory only -- no PII persistence. The validated EmployeeData object is returned in-memory for the next phase to consume.
- **Do NOT parse dates with a library:** The date fields only need format validation (regex) and simple comparison (new Date()). Adding date-fns or similar is unnecessary weight.
- **Do NOT retry extraction on validation failure:** If Zod validation fails, the data on the page is incomplete or malformed. Retrying will get the same result. Throw immediately with the field-level error details.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Data validation | Custom if/else validation chains | Zod `safeParse` | Type inference, structured errors with field paths, regex validators built in |
| Error formatting | Custom error message builder | `z.prettifyError()` or `z.flattenError()` | Produces human-readable field-level error messages automatically |
| Shadow DOM piercing | Manual `page.evaluate()` with `shadowRoot.querySelector()` | Playwright CSS/text locators | Playwright automatically pierces shadow DOM boundaries with CSS and text selectors |
| Date comparison | Custom date parsing logic | `new Date(dateString)` + comparison | Built-in Date constructor handles standard date formats; only comparing, not manipulating |
| Type definitions | Manual interface separate from validation | `z.infer<typeof Schema>` | Single source of truth -- schema IS the type definition |

**Key insight:** Zod eliminates the entire "validate then type-cast" problem. The schema defines both the runtime validation and the TypeScript type. `safeParse` returns either typed data or structured errors -- no custom validation code needed.

## Common Pitfalls

### Pitfall 1: Salesforce Shadow DOM Complexity
**What goes wrong:** Selectors that work in browser DevTools fail in Playwright because they use XPath or target closed shadow roots.
**Why it happens:** Salesforce Lightning Web Components use shadow DOM encapsulation. While Playwright CSS/text locators pierce open shadow DOM by default, XPath does NOT pierce shadow boundaries, and closed shadow roots are inaccessible.
**How to avoid:** Use ONLY CSS selectors and text-based Playwright locators (`getByText`, `getByRole`, `getByLabel`). Never use XPath for Salesforce pages. If a specific element is inside a closed shadow root, use `page.evaluate()` with `document.querySelector()` as a last resort.
**Warning signs:** `locator.textContent()` returns null on an element that is clearly visible in the browser.

### Pitfall 2: Search Results Loading Asynchronously
**What goes wrong:** Code tries to read search results before they finish loading, getting stale or empty data.
**Why it happens:** Salesforce uses client-side rendering. After search submission, results load via AJAX/fetch -- the DOM updates asynchronously after the initial page load event.
**How to avoid:** After submitting search, wait for a specific result element to appear rather than relying on `domcontentloaded`. Use `page.waitForSelector()` targeting the results table/container, or `page.waitForLoadState("networkidle")` as a broader signal. Add explicit waits for result count > 0 before proceeding.
**Warning signs:** Extraction works on fast connections but fails intermittently on slower ones.

### Pitfall 3: Date Format Ambiguity
**What goes wrong:** Date comparison fails because dates from ACT CRM use an unexpected format (e.g., "Mar 13, 2026" instead of "03/13/2026").
**Why it happens:** Salesforce formats dates according to the org's locale settings, which may differ from what the developer assumes.
**How to avoid:** When parsing dates for comparison (EXTR-02), use `new Date(dateString)` which handles multiple formats. For the Zod schema (EXTR-05), accept multiple date formats via regex union or use a Zod `.transform()` to normalize. During live testing, observe the actual format and tighten the schema accordingly.
**Warning signs:** "Latest date" selection picks the wrong row, or date validation rejects valid dates.

### Pitfall 4: SSN Display Format Variations
**What goes wrong:** SSN is extracted as "***-**-1234" (partially masked) or "123456789" (no hyphens) instead of "123-45-6789".
**Why it happens:** Security-conscious systems often mask SSN display. Salesforce may show partial SSN by default, or the UCPath Entry Sheet may use a different format than expected.
**How to avoid:** During live testing, verify the exact SSN display format on the UCPath Entry Sheet. The Zod schema should match reality -- if SSN is always fully displayed with hyphens, validate for that exact format. If it is partially masked, that is a blocking issue that must be escalated (cannot extract masked data).
**Warning signs:** SSN field consistently fails Zod validation despite being present on the page.

### Pitfall 5: Empty Fields vs Missing Fields
**What goes wrong:** Extraction returns empty string "" for a field that exists on the page but has no value, vs null for a field whose selector did not match at all. Both treated the same by validation.
**Why it happens:** `textContent()` returns "" for an element that exists but contains no text, and throws/returns null when the locator does not match.
**How to avoid:** In the extraction function, treat empty string and null identically -- both mean "field not available." The Zod schema uses `.min(1)` on string fields, which rejects empty strings. Return clear error messages distinguishing "field not found on page" (selector issue) from "field is empty" (data issue).
**Warning signs:** Validation errors say "String must contain at least 1 character(s)" without indicating whether the field was found but empty or not found at all.

### Pitfall 6: Separate Browser Contexts
**What goes wrong:** Extraction code tries to use the UCPath browser context to access ACT CRM, or vice versa.
**Why it happens:** Phase 1 established that UCPath and ACT CRM require separate browser contexts due to cookie conflicts.
**How to avoid:** The extraction workflow ONLY uses the ACT CRM browser context/page. Load the `actcrm` session state, launch a page in that context, and do all work there. Never mix contexts.
**Warning signs:** Navigation to ACT CRM redirects to a login page despite having a saved session.

## Code Examples

### Complete Extraction Pipeline
```typescript
// src/extraction/extract.ts
// Source: Playwright locator API + Zod safeParse pattern
import type { Page } from "playwright";
import { z } from "zod";
import { log } from "../utils/log.js";

export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly failedFields?: string[],
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

// Schema defines BOTH validation rules AND TypeScript type
const EmployeeDataSchema = z.object({
  positionNumber: z.string().min(1, "Position number is required"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  ssn: z.string().regex(
    /^\d{3}-\d{2}-\d{4}$/,
    "SSN must be in XXX-XX-XXXX format",
  ),
  address: z.string().min(1, "Address is required"),
  city: z.string().min(1, "City is required"),
  state: z.string().min(1, "State is required"),
  postalCode: z.string().min(1, "Postal code is required"),
  wage: z.string().min(1, "Wage is required"),
  effectiveDate: z.string().min(1, "Effective date is required"),
});

export type EmployeeData = z.infer<typeof EmployeeDataSchema>;
```

### Zod Validation with Structured Error Output
```typescript
// Source: https://zod.dev/error-formatting
import { z } from "zod";

export function validateEmployeeData(
  raw: Record<string, string | null>,
): EmployeeData {
  // Convert nulls to undefined so Zod sees missing fields correctly
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    cleaned[key] = value ?? undefined;
  }

  const result = EmployeeDataSchema.safeParse(cleaned);

  if (!result.success) {
    // z.flattenError gives field-level error arrays
    const flat = z.flattenError(result.error);
    const failedFields = Object.keys(flat.fieldErrors);

    // z.prettifyError gives human-readable multi-line string
    const prettyMessage = z.prettifyError(result.error);

    throw new ExtractionError(
      `Validation failed for ${failedFields.length} field(s):\n${prettyMessage}`,
      failedFields,
    );
  }

  return result.data;
}
```

### CLI Integration Pattern
```typescript
// Addition to src/cli.ts
// Source: commander subcommand pattern
program
  .command("extract")
  .description("Extract employee data from ACT CRM")
  .argument("<email>", "Employee email to search for")
  .action(async (email: string) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    const { browser, context, page } = await launchBrowser("actcrm");

    try {
      // Verify ACT CRM session is valid
      const valid = await isSessionValid(page, "https://act-crm.my.site.com");
      if (!valid) {
        log.error("ACT CRM session expired -- run test-login first");
        await browser.close();
        process.exit(1);
      }

      log.step("Searching for employee...");
      await searchByEmail(page, email);

      log.step("Selecting latest result...");
      await selectLatestResult(page);

      log.step("Navigating to UCPath Entry Sheet...");
      await navigateToEntrySheet(page);

      log.step("Extracting employee data...");
      const rawData = await extractRawFields(page);

      log.step("Validating extracted data...");
      const data = validateEmployeeData(rawData);

      log.success("Employee data extracted and validated");
      // Print field count summary (no PII values)
      log.step(`Fields extracted: ${Object.keys(data).length}`);

      await browser.close();
    } catch (error) {
      if (error instanceof ExtractionError) {
        log.error(error.message);
        // Do NOT log the raw data -- may contain PII
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`Extraction failed: ${msg}`);
      }
      await browser.close();
      process.exit(1);
    }
  });
```

### Field Extraction with PII-Safe Logging
```typescript
// Source: Playwright locator pattern
const FIELD_MAP: Record<keyof EmployeeData, string[]> = {
  positionNumber: ["Position Number", "Position #", "Position No"],
  firstName: ["First Name", "Legal First Name"],
  lastName: ["Last Name", "Legal Last Name"],
  ssn: ["SSN", "Social Security", "Social Security Number"],
  address: ["Address", "Street Address", "Address Line 1"],
  city: ["City"],
  state: ["State"],
  postalCode: ["Postal Code", "Zip Code", "ZIP"],
  wage: ["Wage", "Pay Rate", "Salary", "Compensation"],
  effectiveDate: ["Effective Date", "Start Date", "Hire Date"],
};

async function extractRawFields(
  page: Page,
): Promise<Record<string, string | null>> {
  const raw: Record<string, string | null> = {};

  for (const [field, labels] of Object.entries(FIELD_MAP)) {
    log.step(`Extracting ${field}...`); // field name only -- never the value
    let value: string | null = null;

    for (const label of labels) {
      value = await extractField(page, label);
      if (value) break;
    }

    raw[field] = value;
  }

  return raw;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Zod 3.x | Zod 4.x (^4.3.6) | July 2025 | 10x faster tsc, 57% smaller bundle, new `z.prettifyError()` and `z.flattenError()` utilities |
| Manual type + validate | `z.infer<typeof Schema>` | Zod 1.0+ (standard) | Single source of truth for types and validation |
| `.parse()` with try/catch | `.safeParse()` result discriminated union | Zod 3.0+ (standard) | No exceptions; cleaner control flow |
| Custom error formatting | `z.prettifyError()` / `z.flattenError()` | Zod 4.0 | Built-in human-readable and field-level error formatting |
| XPath for Salesforce automation | Playwright CSS/text locators | Playwright default | CSS/text pierce shadow DOM; XPath does not |

**Deprecated/outdated:**
- Zod `.format()`: Deprecated in Zod 4 in favor of `z.treeifyError()` -- do not use
- Zod `z.ZodError.flatten()`: Use standalone `z.flattenError(error)` instead in Zod 4
- `page.waitForNavigation()`: Deprecated in Playwright; use `page.waitForURL()` (already established in Phase 1)

## Open Questions

1. **ACT CRM Search Interface Structure**
   - What we know: Portal is at act-crm.my.site.com/hr/a1Z/o (Salesforce Experience Cloud). There is a way to search by email.
   - What's unclear: Whether search is a global search bar, a list view filter, a custom search component, or a URL parameter. Whether results appear as a table, a list, or cards.
   - Recommendation: Build search with flexible selectors (searchbox role, search type input, placeholder text). Plan a live verification step to discover the actual UI and adjust selectors.

2. **UCPath Entry Sheet Page Layout**
   - What we know: It contains position number, first name, last name, SSN, address, city, state, postal code, wage, and effective date.
   - What's unclear: Whether it is a Salesforce record page, a custom Visualforce page, an embedded iframe, or a separate application. Whether fields are in a form layout, a table, or a free-form page.
   - Recommendation: Use multiple extraction strategies (label-based, table-based, ARIA-based) with fallbacks. The FIELD_MAP approach allows trying multiple label variations for each field.

3. **SSN Visibility on UCPath Entry Sheet**
   - What we know: SSN is listed as a required extraction field (EXTR-04).
   - What's unclear: Whether the full SSN is displayed or partially masked (common in secure systems).
   - Recommendation: During live testing, verify SSN display. If masked, this is a blocking issue for the entire extraction pipeline -- cannot extract data that is not shown.

4. **Date Format on ACT CRM**
   - What we know: Need to compare dates (EXTR-02) and extract effective date (EXTR-04).
   - What's unclear: The exact date format used by the ACT CRM (could be MM/DD/YYYY, YYYY-MM-DD, "Mar 13, 2026", etc.).
   - Recommendation: Accept multiple formats in the initial implementation. Tighten validation after observing the actual format during live testing.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node.js built-in test runner (node:test) + TypeScript (tsc --noEmit) |
| Config file | None needed -- built-in runner requires no config |
| Quick run command | `npx tsx --test src/**/*.test.ts` |
| Full suite command | `npx tsx --test src/**/*.test.ts && npx tsc --noEmit` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| EXTR-01 | Search ACT CRM by email | smoke (manual) | Manual: `npm run extract <email>` -- verify search executes | N/A -- manual only |
| EXTR-02 | Select latest date row | smoke (manual) | Manual: `npm run extract <email>` -- verify correct row selected | N/A -- manual only |
| EXTR-03 | Navigate to UCPath Entry Sheet | smoke (manual) | Manual: `npm run extract <email>` -- verify navigation to entry sheet | N/A -- manual only |
| EXTR-04 | Extract all required fields | smoke (manual) | Manual: `npm run extract <email>` -- verify all fields extracted | N/A -- manual only |
| EXTR-05 | Zod schema validates data / rejects bad data | unit | `npx tsx --test src/extraction/schema.test.ts` | No -- Wave 0 |
| -- | Zod schema rejects missing fields with clear errors | unit | `npx tsx --test src/extraction/schema.test.ts` | No -- Wave 0 |
| -- | Zod schema rejects malformed SSN/postal code | unit | `npx tsx --test src/extraction/schema.test.ts` | No -- Wave 0 |
| -- | ExtractionError includes failedFields list | unit | `npx tsx --test src/extraction/schema.test.ts` | No -- Wave 0 |
| -- | TypeScript compiles | unit | `npx tsc --noEmit` | Existing |

### Sampling Rate
- **Per task commit:** `npx tsc --noEmit` (type checking) + `npx tsx --test src/extraction/schema.test.ts` (schema unit tests)
- **Per wave merge:** Full test suite + manual `npm run extract <test-email>`
- **Phase gate:** Manual end-to-end extraction run succeeds: search -> navigate -> extract -> Zod validation passes with all 10 fields populated

### Wave 0 Gaps
- [ ] `src/extraction/schema.test.ts` -- unit tests for Zod schema validation (valid data passes, missing fields rejected with correct field names, malformed SSN/postal code rejected, error messages are human-readable)
- [ ] `package.json` script -- add `"extract": "tsx --env-file=.env src/cli.ts extract"` script

**Note:** EXTR-01 through EXTR-04 are inherently manual-only tests because they require a live authenticated browser session to ACT CRM. They cannot be meaningfully automated without mocking the entire Salesforce portal. The unit-testable surface is EXTR-05 (Zod validation), which can be tested with synthetic data.

## Sources

### Primary (HIGH confidence)
- [Playwright Locators](https://playwright.dev/docs/locators) - CSS/text locators pierce shadow DOM by default; role-based and text-based selectors
- [Playwright Input/Actions](https://playwright.dev/docs/input) - fill(), click(), press() patterns for form interaction
- [Playwright Locator API](https://playwright.dev/docs/api/class-locator) - textContent(), innerText(), evaluate() for extraction
- [Zod Official Docs - API](https://zod.dev/api) - z.object(), z.string(), z.regex(), z.infer, safeParse
- [Zod Official Docs - Basic Usage](https://zod.dev/basics) - safeParse discriminated union pattern
- [Zod Official Docs - Error Formatting](https://zod.dev/error-formatting) - z.flattenError(), z.prettifyError(), z.treeifyError()

### Secondary (MEDIUM confidence)
- [Zod v4 Release Notes](https://zod.dev/v4) - v4.0 released July 2025, current stable ^4.3.6; 10x faster tsc, 57% smaller bundle
- [Zod Versioning](https://zod.dev/v4/versioning) - `npm install zod@^4` for new projects
- [Salesforce Shadow DOM](https://developer.salesforce.com/docs/component-library/documentation/lwc/lwc.create_dom) - Lightning Web Components use shadow DOM
- [Playwright Shadow DOM Piercing](https://www.testingmavens.com/blogs/interacting-with-shadow-dom-the) - CSS/text locators auto-pierce; XPath does NOT
- [Salesforce + Playwright Challenges](https://www.testrigtechnologies.com/salesforce-test-automation-with-playwright-challenges-setup-and-proven-strategies/) - Dynamic IDs, shadow DOM, Lightning framework quirks
- [SSN Validation Regex](https://ihateregex.io/expr/ssn/) - Standard SSN regex pattern: `/^\d{3}-\d{2}-\d{4}$/`

### Tertiary (LOW confidence)
- ACT CRM portal search UI structure -- requires authenticated live session to inspect
- UCPath Entry Sheet field layout -- requires authenticated live navigation to inspect
- SSN display format on UCPath Entry Sheet -- unknown whether masked or full
- Date format used in ACT CRM result list -- unknown locale/format

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Playwright already in use; Zod 4 is well-documented, verified on official docs
- Architecture: HIGH - Extraction pipeline pattern (search -> navigate -> extract -> validate) is straightforward; Zod safeParse pattern comes directly from official docs
- Pitfalls: MEDIUM - Shadow DOM and async loading are well-known Salesforce challenges; specific ACT CRM behavior is unverified
- Selectors: LOW - Cannot determine actual ACT CRM DOM structure without live authenticated session; all selectors are best-guess placeholders

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (30 days -- Playwright and Zod are stable; ACT CRM selectors are the volatile element)
