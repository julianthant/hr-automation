# Parallel Onboarding Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add parallel batch processing, enhanced Excel tracking with daily worksheets, no-SSN handling, and CRM document download to the onboarding workflow.

**Architecture:** Queue-based worker pool orchestrates N concurrent browser pairs. Each worker processes employees from a shared queue, writing to a mutex-protected Excel tracker with daily worksheet tabs. The existing auth/CRM/UCPath modules remain untouched — parallelism is pure orchestration.

**Tech Stack:** ExcelJS, async-mutex (new), yaml (new), Playwright, Commander, Zod

**Spec:** `docs/superpowers/specs/2026-03-16-parallel-onboarding-design.md`

---

## Chunk 1: Tracker Overhaul

### Task 1: Install new dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install async-mutex and yaml**

Run: `npm install async-mutex yaml`

- [ ] **Step 2: Verify installation**

Run: `npm ls async-mutex yaml`
Expected: Both packages listed without errors

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add async-mutex and yaml dependencies"
```

---

### Task 2: Update tracker columns

**Files:**
- Modify: `src/tracker/columns.ts`

- [ ] **Step 1: Replace TRACKER_COLUMNS with expanded column list**

Replace the entire contents of `src/tracker/columns.ts` with:

```typescript
export const TRACKER_COLUMNS = [
  { header: "First Name", key: "firstName", width: 15 },
  { header: "Middle Name", key: "middleName", width: 15 },
  { header: "Last Name", key: "lastName", width: 15 },
  { header: "SSN", key: "ssn", width: 15 },
  { header: "DOB", key: "dob", width: 12 },
  { header: "Phone", key: "phone", width: 15 },
  { header: "Email", key: "email", width: 25 },
  { header: "Address", key: "address", width: 25 },
  { header: "City", key: "city", width: 15 },
  { header: "State", key: "state", width: 8 },
  { header: "Postal Code", key: "postalCode", width: 12 },
  { header: "Dept #", key: "departmentNumber", width: 10 },
  { header: "Recruitment #", key: "recruitmentNumber", width: 15 },
  { header: "Position #", key: "positionNumber", width: 12 },
  { header: "Wage", key: "wage", width: 15 },
  { header: "Effective Date", key: "effectiveDate", width: 14 },
  { header: "Appointment", key: "appointment", width: 12 },
  { header: "CRM Extraction", key: "crmExtraction", width: 14 },
  { header: "Person Search", key: "personSearch", width: 14 },
  { header: "Rehire", key: "rehire", width: 8 },
  { header: "I9 Record", key: "i9Record", width: 12 },
  { header: "Transaction", key: "transaction", width: 14 },
  { header: "PDF Download", key: "pdfDownload", width: 14 },
  { header: "I9 Profile ID", key: "i9ProfileId", width: 14 },
  { header: "Status", key: "status", width: 12 },
  { header: "Error", key: "error", width: 30 },
  { header: "Timestamp", key: "timestamp", width: 22 },
];
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npx tsc --noEmit`
Expected: May show errors in spreadsheet.ts and builder.ts (expected — those files reference old interface). Columns file itself should be clean.

---

### Task 3: Update TrackerRow interface and daily worksheets

**Files:**
- Modify: `src/tracker/spreadsheet.ts`

- [ ] **Step 1: Replace the entire contents of spreadsheet.ts**

```typescript
import ExcelJS from "exceljs";
import { TRACKER_COLUMNS } from "./columns.js";

export interface TrackerRow {
  firstName: string;
  middleName: string;
  lastName: string;
  ssn: string;
  dob: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  departmentNumber: string;
  recruitmentNumber: string;
  positionNumber: string;
  wage: string;
  effectiveDate: string;
  appointment: string;
  crmExtraction: string;
  personSearch: string;
  rehire: string;
  i9Record: string;
  transaction: string;
  pdfDownload: string;
  i9ProfileId: string;
  status: string;
  error: string;
  timestamp: string;
}

/**
 * Extract a 4-6 digit department number from parenthesized text.
 * Returns the last match if multiple parenthesized numbers exist.
 * Example: "Computer Science (000412)" -> "000412"
 * Returns null if no match found.
 */
export function parseDepartmentNumber(deptText: string): string | null {
  const matches = [...deptText.matchAll(/\((\d{4,6})\)/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

/**
 * Create or append to an onboarding tracker .xlsx file.
 * Uses daily worksheet tabs named YYYY-MM-DD.
 * If today's tab exists, appends. If not, creates it.
 */
export async function updateTracker(filePath: string, data: TrackerRow): Promise<void> {
  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.readFile(filePath);
  } catch {
    // File does not exist yet — fresh workbook
  }

  const today = new Date().toISOString().slice(0, 10);
  let sheet = workbook.getWorksheet(today);

  if (!sheet) {
    sheet = workbook.addWorksheet(today);
    sheet.columns = TRACKER_COLUMNS;
    sheet.getRow(1).font = { bold: true };
  } else {
    // ExcelJS loses column key mapping after readFile.
    // Re-apply keys so addRow(object) maps correctly.
    for (let i = 0; i < TRACKER_COLUMNS.length; i++) {
      const col = sheet.getColumn(i + 1);
      col.key = TRACKER_COLUMNS[i].key;
    }
  }

  sheet.addRow(data);
  await workbook.xlsx.writeFile(filePath);
}
```

Note: `maskSsn` is removed — SSN is stored unmasked per spec.

---

### Task 4: Update tracker builder

**Files:**
- Modify: `src/tracker/builder.ts`

- [ ] **Step 1: Replace the entire contents of builder.ts**

```typescript
import type { TrackerRow } from "./spreadsheet.js";
import type { EmployeeData } from "../workflows/onboarding/schema.js";

export interface TrackerStatus {
  crmExtraction: string;
  personSearch: string;
  rehire: string;
  i9Record: string;
  transaction: string;
  pdfDownload: string;
  i9ProfileId: string;
  status: string;
  error: string;
}

/**
 * Build a TrackerRow from extracted employee data and workflow status.
 * Timestamp is set automatically to the current ISO time.
 */
export function buildTrackerRow(data: EmployeeData, status: TrackerStatus): TrackerRow {
  return {
    firstName: data.firstName,
    middleName: data.middleName ?? "",
    lastName: data.lastName,
    ssn: data.ssn ?? "",
    dob: data.dob ?? "",
    phone: data.phone ?? "",
    email: data.email ?? "",
    address: data.address,
    city: data.city,
    state: data.state,
    postalCode: data.postalCode,
    departmentNumber: data.departmentNumber ?? "",
    recruitmentNumber: data.recruitmentNumber ?? "",
    positionNumber: data.positionNumber,
    wage: data.wage,
    effectiveDate: data.effectiveDate,
    appointment: data.appointment ?? "",
    crmExtraction: status.crmExtraction,
    personSearch: status.personSearch,
    rehire: status.rehire,
    i9Record: status.i9Record,
    transaction: status.transaction,
    pdfDownload: status.pdfDownload,
    i9ProfileId: status.i9ProfileId,
    status: status.status,
    error: status.error,
    timestamp: new Date().toISOString(),
  };
}
```

---

### Task 5: Update tracker barrel exports

**Files:**
- Modify: `src/tracker/index.ts`

- [ ] **Step 1: Replace contents of index.ts**

```typescript
export { updateTracker, parseDepartmentNumber } from "./spreadsheet.js";
export type { TrackerRow } from "./spreadsheet.js";
export { TRACKER_COLUMNS } from "./columns.js";
export { buildTrackerRow } from "./builder.js";
export type { TrackerStatus } from "./builder.js";
```

Note: `maskSsn` export removed — no longer exists.

---

### Task 6: Update tracker tests

**Files:**
- Modify: `tests/unit/tracker.test.ts`

- [ ] **Step 1: Replace the entire contents of tracker.test.ts**

```typescript
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import ExcelJS from "exceljs";
import {
  parseDepartmentNumber,
  updateTracker,
  TRACKER_COLUMNS,
} from "../../src/tracker/index.js";
import type { TrackerRow } from "../../src/tracker/index.js";

const SAMPLE_ROW: TrackerRow = {
  firstName: "Jane",
  middleName: "",
  lastName: "Doe",
  ssn: "123-45-6789",
  dob: "01/15/1990",
  phone: "(858) 555-1234",
  email: "jane@ucsd.edu",
  address: "123 Main St",
  city: "San Diego",
  state: "CA",
  postalCode: "92093",
  departmentNumber: "000412",
  recruitmentNumber: "REQ-12345",
  positionNumber: "10026229",
  wage: "$17.75 per hour",
  effectiveDate: "01/15/2026",
  appointment: "5",
  crmExtraction: "Done",
  personSearch: "Done",
  rehire: "",
  i9Record: "Done",
  transaction: "Done",
  pdfDownload: "Done",
  i9ProfileId: "MOCK_I9",
  status: "Done",
  error: "",
  timestamp: "2026-01-15T10:00:00.000Z",
};

describe("parseDepartmentNumber", () => {
  it('parses "Computer Science (000412)" to "000412"', () => {
    assert.equal(parseDepartmentNumber("Computer Science (000412)"), "000412");
  });

  it('parses "Biology (000301)" to "000301"', () => {
    assert.equal(parseDepartmentNumber("Biology (000301)"), "000301");
  });

  it('returns null for "Unknown Department" (no parenthesized number)', () => {
    assert.equal(parseDepartmentNumber("Unknown Department"), null);
  });

  it('extracts last match from "Some (text) Dept (000412)"', () => {
    assert.equal(
      parseDepartmentNumber("Some (text) Dept (000412)"),
      "000412",
    );
  });
});

describe("updateTracker", () => {
  const tempFiles: string[] = [];

  function tempPath(): string {
    const p = join(tmpdir(), `tracker-test-${randomUUID()}.xlsx`);
    tempFiles.push(p);
    return p;
  }

  afterEach(async () => {
    for (const f of tempFiles) {
      try {
        await unlink(f);
      } catch {
        // file may not exist
      }
    }
    tempFiles.length = 0;
  });

  it("creates new .xlsx with today's date as sheet name and correct column headers", async () => {
    const filePath = tempPath();
    await updateTracker(filePath, SAMPLE_ROW);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const today = new Date().toISOString().slice(0, 10);
    const sheet = workbook.getWorksheet(today);
    assert.ok(sheet, `Sheet '${today}' should exist`);

    const headerRow = sheet.getRow(1);
    const headers = TRACKER_COLUMNS.map((col) => col.header);
    assert.equal(headers.length, 27, "Should have 27 columns defined");

    for (let i = 0; i < headers.length; i++) {
      assert.equal(
        headerRow.getCell(i + 1).value,
        headers[i],
        `Column ${i + 1} header should be "${headers[i]}"`,
      );
    }
  });

  it("appends row to existing daily sheet without losing previous rows", async () => {
    const filePath = tempPath();

    const row1: TrackerRow = { ...SAMPLE_ROW, firstName: "Alice" };
    const row2: TrackerRow = { ...SAMPLE_ROW, firstName: "Bob" };

    await updateTracker(filePath, row1);
    await updateTracker(filePath, row2);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const today = new Date().toISOString().slice(0, 10);
    const sheet = workbook.getWorksheet(today);
    assert.ok(sheet, "Sheet should exist");

    assert.equal(sheet.rowCount, 3, "Should have 3 rows (1 header + 2 data)");
    assert.equal(sheet.getRow(2).getCell(1).value, "Alice");
    assert.equal(sheet.getRow(3).getCell(1).value, "Bob");
  });

  it("stores full SSN without masking", async () => {
    const filePath = tempPath();
    await updateTracker(filePath, SAMPLE_ROW);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const today = new Date().toISOString().slice(0, 10);
    const sheet = workbook.getWorksheet(today)!;
    // SSN is column 4
    assert.equal(sheet.getRow(2).getCell(4).value, "123-45-6789");
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx tsx --test tests/unit/tracker.test.ts`
Expected: All tests pass

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: May show errors in workflow.ts and other files that still use old TrackerStatus — that's expected and will be fixed in Chunk 2.

- [ ] **Step 4: Commit**

```bash
git add src/tracker/ tests/unit/tracker.test.ts
git commit -m "feat: overhaul tracker with expanded columns and daily worksheets"
```

---

## Chunk 2: Schema, No-SSN, Transaction, and Workflow Refactor

### Task 7: Update SSN schema to accept empty string

**Files:**
- Modify: `src/workflows/onboarding/schema.ts`

- [ ] **Step 1: Update SSN field in EmployeeDataSchema**

In `src/workflows/onboarding/schema.ts`, change line 9-12 from:

```typescript
  ssn: z.string().regex(
    /^\d{3}-\d{2}-\d{4}$/,
    "SSN must be in XXX-XX-XXXX format",
  ).optional(),
```

To:

```typescript
  ssn: z.string().regex(
    /^\d{3}-\d{2}-\d{4}$/,
    "SSN must be in XXX-XX-XXXX format",
  ).optional().or(z.literal("")),
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: schema.ts compiles cleanly (workflow.ts may still have errors — expected)

---

### Task 8: Make SSN optional in PersonalDataInput

**Files:**
- Modify: `src/ucpath/transaction.ts:186-199`

- [ ] **Step 1: Change `ssn` from required to optional in PersonalDataInput**

In `src/ucpath/transaction.ts`, change line 191 from:

```typescript
  ssn: string; // without dashes — just digits
```

To:

```typescript
  ssn?: string; // without dashes — just digits; optional for international students
```

- [ ] **Step 2: Add conditional guard around SSN fill**

In `src/ucpath/transaction.ts`, change lines 240-244 from:

```typescript
  // --- National ID (SSN) ---
  // SELECTOR: verified v1.0 — textbox "National ID" (exact match to avoid National ID Type)
  log.step("Filling national ID...");
  await frame.getByRole("textbox", { name: "National ID", exact: true }).fill(data.ssn, { timeout: 10_000 });
  log.step("National ID filled");
```

To:

```typescript
  // --- National ID (SSN) ---
  if (data.ssn) {
    // SELECTOR: verified v1.0 — textbox "National ID" (exact match to avoid National ID Type)
    log.step("Filling national ID...");
    await frame.getByRole("textbox", { name: "National ID", exact: true }).fill(data.ssn, { timeout: 10_000 });
    log.step("National ID filled");
  } else {
    log.step("No SSN — skipping national ID field");
  }
```

---

### Task 9: Add no-SSN comment logic

**Files:**
- Modify: `src/ucpath/transaction.ts:557-562`

- [ ] **Step 1: Update buildCommentsText to accept optional hasSsn parameter**

In `src/ucpath/transaction.ts`, replace the `buildCommentsText` function (lines 557-562) with:

```typescript
/**
 * Build the comments string for a new hire transaction.
 *
 * When SSN is present:
 *   "New Dining Student Hire Effective {date}. Job number #{num}."
 *
 * When SSN is missing (international student):
 *   "New Dining Student Hire Effective {date}. Job number #{num}. International Student. NO SSN."
 */
export function buildCommentsText(
  effectiveDate: string,
  recruitmentNumber: string,
  hasSsn = true,
): string {
  const base = `New Dining Student Hire Effective ${effectiveDate}. Job number #${recruitmentNumber}.`;
  if (!hasSsn) {
    return `${base} International Student. NO SSN.`;
  }
  return base;
}
```

- [ ] **Step 2: Update SSN pass-through in enter.ts to produce `undefined` instead of `""`**

In `src/workflows/onboarding/enter.ts`, change line 96 from:

```typescript
  const ssnDigits = data.ssn?.replace(/-/g, "") ?? "";
```

To:

```typescript
  // data.ssn may be undefined or "" (both mean no SSN provided)
  const ssnDigits = data.ssn ? data.ssn.replace(/-/g, "") : undefined;
```

- [ ] **Step 3: Update buildCommentsText call in enter.ts**

In `src/workflows/onboarding/enter.ts`, change lines 118-121 from:

```typescript
  const commentsText = buildCommentsText(
    data.effectiveDate,
    data.recruitmentNumber ?? "N/A",
  );
```

To:

```typescript
  // data.ssn may be undefined or "" (both mean no SSN provided)
  const hasSsn = Boolean(data.ssn);
  const commentsText = buildCommentsText(
    data.effectiveDate,
    data.recruitmentNumber ?? "N/A",
    hasSsn,
  );
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: transaction.ts and enter.ts compile cleanly

- [ ] **Step 4: Commit**

```bash
git add src/workflows/onboarding/schema.ts src/ucpath/transaction.ts src/workflows/onboarding/enter.ts
git commit -m "feat: add no-SSN handling for international students"
```

---

### Task 10: Update config and tracker path

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Update TRACKER_PATH**

In `src/config.ts`, change line 28 from:

```typescript
export const TRACKER_PATH = "./onboarding-tracker.xlsx";
```

To:

```typescript
export const TRACKER_PATH = "./src/workflows/onboarding/onboarding-tracker.xlsx";
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "chore: move tracker path to workflow-specific location"
```

---

### Task 11: Refactor workflow to accept browser instances and new tracker status

**Files:**
- Modify: `src/workflows/onboarding/workflow.ts`

The workflow needs these changes:
1. Accept optional pre-launched browser pages (for parallel worker reuse)
2. Accept optional locked tracker function (for mutex-safe writes)
3. Accept optional log prefix (for worker identification)
4. Use new `TrackerStatus` interface with expanded fields
5. Throw errors instead of `process.exit(1)` so parallel workers can catch them
6. Integrate PDF download placeholder (actual download code in Task 13)

- [ ] **Step 1: Replace workflow.ts contents**

```typescript
import type { Page } from "playwright";
import { launchBrowser } from "../../browser/launch.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { TRACKER_PATH } from "../../config.js";
import { loginToUCPath, loginToACTCrm } from "../../auth/login.js";
import {
  searchByEmail,
  selectLatestResult,
  navigateToSection,
  ExtractionError,
} from "../../crm/index.js";
import { TransactionError } from "../../ucpath/types.js";
import { searchPerson } from "../../ucpath/navigate.js";
import {
  updateTracker as defaultUpdateTracker,
  buildTrackerRow,
} from "../../tracker/index.js";
import type { TrackerRow } from "../../tracker/index.js";
import {
  extractRawFields,
  extractRecordPageFields,
  validateEmployeeData,
  buildTransactionPlan,
} from "./index.js";
import type { EmployeeData } from "./index.js";

export interface OnboardingOptions {
  dryRun?: boolean;
  /** Pre-launched CRM page (for parallel worker reuse). If omitted, launches a new browser. */
  crmPage?: Page;
  /** Pre-launched UCPath page (for parallel worker reuse). If omitted, launches a new browser. */
  ucpathPage?: Page;
  /** Mutex-wrapped tracker write function. If omitted, uses default updateTracker. */
  updateTrackerFn?: (filePath: string, data: TrackerRow) => Promise<void>;
  /** Log prefix for worker identification, e.g. "[Worker 1]". */
  logPrefix?: string;
}

function prefixed(prefix: string | undefined, msg: string): string {
  return prefix ? `${prefix} ${msg}` : msg;
}

/**
 * Run the full onboarding workflow for a single employee.
 *
 * In single mode (no options.crmPage): launches its own browsers, exits on error.
 * In parallel mode (options.crmPage provided): uses worker's browsers, throws on error.
 */
export async function runOnboarding(
  email: string,
  options: OnboardingOptions = {},
): Promise<void> {
  const p = options.logPrefix;
  const writeTracker = options.updateTrackerFn ?? defaultUpdateTracker;
  const isParallel = Boolean(options.crmPage);
  let data: EmployeeData;

  // Helper: exit in single mode, throw in parallel mode
  function fail(msg: string): never {
    if (isParallel) throw new Error(msg);
    log.error(prefixed(p, msg));
    process.exit(1);
  }

  // --- Step 1: Extract data from ACT CRM ---
  const crmPage = options.crmPage ?? (await launchBrowser()).page;
  let recordFields: { departmentNumber: string | null; recruitmentNumber: string | null } = {
    departmentNumber: null,
    recruitmentNumber: null,
  };

  try {
    log.step(prefixed(p, "Authenticating to ACT CRM..."));
    const authOk = await loginToACTCrm(crmPage);
    if (!authOk) fail("ACT CRM authentication failed -- cannot extract");

    log.step(prefixed(p, `Searching for ${email}...`));
    await searchByEmail(crmPage, email);

    log.step(prefixed(p, "Selecting latest result..."));
    await selectLatestResult(crmPage);

    log.step(prefixed(p, "Extracting record page fields..."));
    recordFields = await extractRecordPageFields(crmPage);

    // TODO: PDF download step will be added here (Task 13)

    log.step(prefixed(p, "Navigating to UCPath Entry Sheet..."));
    await navigateToSection(crmPage, "UCPath Entry Sheet");

    log.step(prefixed(p, "Extracting employee data..."));
    const rawData = await extractRawFields(crmPage);

    log.step(prefixed(p, "Validating extracted data..."));
    data = validateEmployeeData(rawData);

    if (recordFields.departmentNumber) {
      data = { ...data, departmentNumber: recordFields.departmentNumber };
    }
    if (recordFields.recruitmentNumber) {
      data = { ...data, recruitmentNumber: recordFields.recruitmentNumber };
    }

    log.success(prefixed(p, "Employee data extracted and validated"));
  } catch (error) {
    const errMsg = error instanceof ExtractionError
      ? error.message
      : `Extraction failed: ${errorMessage(error)}`;

    // In parallel mode, write error to tracker before throwing
    if (isParallel) {
      try {
        // data may not be populated — use email as identifier
        await writeTracker(TRACKER_PATH, {
          firstName: "", middleName: "", lastName: "", ssn: "", dob: "",
          phone: "", email, address: "", city: "", state: "", postalCode: "",
          departmentNumber: "", recruitmentNumber: "", positionNumber: "",
          wage: "", effectiveDate: "", appointment: "",
          crmExtraction: "Failed", personSearch: "", rehire: "",
          i9Record: "", transaction: "", pdfDownload: "",
          i9ProfileId: "", status: "Failed", error: errMsg,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Non-fatal
      }
    }

    fail(errMsg);
  }

  // --- Step 2: Dry-run mode ---
  if (options.dryRun) {
    const plan = buildTransactionPlan(data, null as unknown as Page, "DRY_RUN");
    log.step(prefixed(p, "=== DRY RUN MODE ==="));
    plan.preview();

    try {
      await writeTracker(TRACKER_PATH, buildTrackerRow(data, {
        crmExtraction: "Done",
        personSearch: "Dry Run",
        rehire: "",
        i9Record: "Dry Run",
        transaction: "Dry Run",
        pdfDownload: "Dry Run",
        i9ProfileId: "Dry Run",
        status: "Dry Run",
        error: "",
      }));
      log.success(prefixed(p, `Tracker updated: ${TRACKER_PATH}`));
    } catch (trackerErr) {
      log.error(prefixed(p, `Tracker update failed (non-fatal): ${errorMessage(trackerErr)}`));
    }

    log.success(prefixed(p, "Dry run complete -- no changes made to UCPath"));
    return;
  }

  // --- Step 3: UCPath -- person search + transaction ---
  const ucpathPage = options.ucpathPage ?? (await launchBrowser()).page;
  try {
    log.step(prefixed(p, "Authenticating to UCPath..."));
    const ucpathOk = await loginToUCPath(ucpathPage);
    if (!ucpathOk) fail("UCPath authentication failed");

    const ssnDigits = data.ssn?.replace(/-/g, "") ?? "";
    log.step(prefixed(p, "Checking for existing person in UCPath..."));
    const searchResult = await searchPerson(
      ucpathPage,
      ssnDigits,
      data.firstName,
      data.lastName,
      data.dob ?? "",
    );

    if (searchResult.found) {
      log.error(prefixed(p, "Person already exists in UCPath -- rehire"));
      if (searchResult.matches) {
        for (const m of searchResult.matches) {
          log.step(prefixed(p, `  Empl ID: ${m.emplId}, Name: ${m.firstName} ${m.lastName}`));
        }
      }

      try {
        await writeTracker(TRACKER_PATH, buildTrackerRow(data, {
          crmExtraction: "Done",
          personSearch: "Done",
          rehire: "X",
          i9Record: "N/A",
          transaction: "N/A",
          pdfDownload: "",
          i9ProfileId: "N/A",
          status: "Rehire",
          error: "",
        }));
        log.success(prefixed(p, `Tracker updated: ${TRACKER_PATH}`));
      } catch (trackerErr) {
        log.error(prefixed(p, `Tracker update failed (non-fatal): ${errorMessage(trackerErr)}`));
      }

      return;
    }

    log.success(prefixed(p, "No duplicate found -- proceeding with transaction"));

    const i9ProfileId = "MOCK_I9";
    log.step(prefixed(p, "I9 skipped (mock mode) -- Profile ID: MOCK_I9"));

    const plan = buildTransactionPlan(data, ucpathPage, i9ProfileId);
    log.step(prefixed(p, "Executing transaction plan..."));
    await plan.execute();

    log.success(prefixed(p, "Transaction created successfully in UCPath"));

    try {
      await writeTracker(TRACKER_PATH, buildTrackerRow(data, {
        crmExtraction: "Done",
        personSearch: "Done",
        rehire: "",
        i9Record: "Done",
        transaction: "Done",
        pdfDownload: "",
        i9ProfileId,
        status: "Done",
        error: "",
      }));
      log.success(prefixed(p, `Tracker updated: ${TRACKER_PATH}`));
    } catch (trackerErr) {
      log.error(prefixed(p, `Tracker update failed (non-fatal): ${errorMessage(trackerErr)}`));
    }
  } catch (error) {
    // In parallel mode, update tracker with error then re-throw
    if (isParallel) {
      const errMsg = error instanceof TransactionError
        ? `Transaction failed at step: ${error.step ?? "unknown"} — ${error.message}`
        : errorMessage(error);

      try {
        await writeTracker(TRACKER_PATH, buildTrackerRow(data, {
          crmExtraction: "Done",
          personSearch: "Done",
          rehire: "",
          i9Record: "",
          transaction: "Failed",
          pdfDownload: "",
          i9ProfileId: "",
          status: "Failed",
          error: errMsg,
        }));
      } catch {
        // Non-fatal
      }

      throw error;
    }

    // Single mode: log and exit
    if (error instanceof TransactionError) {
      log.error(`Transaction failed at step: ${error.step ?? "unknown"}`);
      log.error(error.message);
    } else {
      log.error(`Transaction failed: ${errorMessage(error)}`);
    }
    process.exit(1);
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: Clean compilation

- [ ] **Step 3: Run all tests**

Run: `npx tsx --test tests/unit/tracker.test.ts`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/workflows/onboarding/workflow.ts
git commit -m "refactor: workflow accepts browser instances and expanded tracker status"
```

---

## Chunk 3: Parallel Processing, CLI, Download, and Docs

### Task 12: Create batch file template

**Files:**
- Create: `src/workflows/onboarding/batch.yaml`

- [ ] **Step 1: Create empty batch template**

```yaml
# Onboarding batch file — one email per line
# Example:
# - john.doe@ucsd.edu
# - jane.smith@ucsd.edu
```

- [ ] **Step 2: Commit**

```bash
git add src/workflows/onboarding/batch.yaml
git commit -m "chore: add onboarding batch file template"
```

---

### Task 13: Create CRM document download module

**Files:**
- Create: `src/workflows/onboarding/download.ts`

This module handles folder creation and PDF download from the CRM document viewer.

**IMPORTANT:** The PDF download selectors require a playwright-cli investigation spike before finalizing. The folder creation logic is implemented now; the download selectors are placeholders marked with `// SELECTOR: TODO — requires playwright-cli discovery`.

- [ ] **Step 1: Create download.ts**

```typescript
import type { Page } from "playwright";
import { mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { log } from "../../utils/log.js";

/**
 * Build the employee download folder path.
 * Format: {Downloads}/onboarding/{Last Name, First Name Middle Name EID}/
 */
export function buildDownloadPath(firstName: string, lastName: string, middleName?: string): string {
  const downloads = join(homedir(), "Downloads");
  const middle = middleName ? ` ${middleName}` : "";
  const folderName = `${lastName}, ${firstName}${middle} EID`;
  return join(downloads, "onboarding", folderName);
}

/**
 * Ensure the employee download folder exists (creates recursively if needed).
 */
export async function ensureDownloadFolder(folderPath: string): Promise<void> {
  await mkdir(folderPath, { recursive: true });
  log.step(`Download folder ready: ${folderPath}`);
}

/**
 * Download CRM documents 1 and 3 from the record page PDF viewer.
 *
 * Must be called while on the main CRM record page, BEFORE navigating
 * to UCPath Entry Sheet.
 *
 * SELECTOR: TODO — requires playwright-cli discovery to identify:
 *   - Document selector control
 *   - PDF viewer element
 *   - Scroll mechanism
 *   - Download trigger
 *
 * @param page - CRM browser page (on record page)
 * @param folderPath - Destination folder for downloaded PDFs
 * @param prefix - Optional log prefix for worker identification
 */
export async function downloadCrmDocuments(
  page: Page,
  folderPath: string,
  prefix?: string,
): Promise<void> {
  const p = prefix;
  const msg = (s: string) => (p ? `${p} ${s}` : s);

  await ensureDownloadFolder(folderPath);

  // Download Document 1
  log.step(msg("Downloading CRM Document 1..."));
  await downloadDocument(page, 1, folderPath);
  log.step(msg("Document 1 downloaded"));

  // Download Document 3
  log.step(msg("Downloading CRM Document 3..."));
  await downloadDocument(page, 3, folderPath);
  log.step(msg("Document 3 downloaded"));

  log.success(msg("CRM document download complete"));
}

/**
 * Download a single document by number from the CRM document viewer.
 *
 * SELECTOR: TODO — all selectors in this function require playwright-cli
 * investigation. The implementation below is a structural placeholder.
 */
async function downloadDocument(
  page: Page,
  documentNumber: number,
  folderPath: string,
): Promise<void> {
  // SELECTOR: TODO — select document from dropdown/list
  // Example (placeholder): await page.selectOption('#documentSelector', `${documentNumber}`);
  // await page.waitForTimeout(2_000);

  // SELECTOR: TODO — scroll PDF viewer to end to ensure all pages load
  // Example (placeholder): await page.evaluate(() => { pdfViewer.scrollTo(0, pdfViewer.scrollHeight) });
  // await page.waitForTimeout(2_000);

  // SELECTOR: TODO — trigger download
  // Likely approach: intercept PDF URL from network, or click download button
  // const download = await page.waitForEvent('download');
  // await download.saveAs(join(folderPath, `document-${documentNumber}.pdf`));

  log.step(`Document ${documentNumber} download: TODO — awaiting playwright-cli selector discovery`);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/workflows/onboarding/download.ts
git commit -m "feat: add CRM document download module (selectors pending playwright-cli)"
```

---

### Task 14: Create parallel processing module

**Files:**
- Create: `src/workflows/onboarding/parallel.ts`

- [ ] **Step 1: Create parallel.ts**

```typescript
import { readFile } from "fs/promises";
import { parse } from "yaml";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { Mutex } from "async-mutex";
import { launchBrowser } from "../../browser/launch.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { updateTracker } from "../../tracker/index.js";
import type { TrackerRow } from "../../tracker/index.js";
import { runOnboarding } from "./workflow.js";
import type { OnboardingOptions } from "./workflow.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BATCH_FILE = join(__dirname, "batch.yaml");

/**
 * Create a mutex-wrapped version of updateTracker.
 * Ensures only one worker writes to the Excel file at a time.
 */
function createLockedTracker(mutex: Mutex) {
  return async (filePath: string, data: TrackerRow): Promise<void> => {
    const release = await mutex.acquire();
    try {
      await updateTracker(filePath, data);
    } finally {
      release();
    }
  };
}

/**
 * Load and validate the batch file.
 * Returns a list of email addresses.
 */
export async function loadBatchFile(): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(BATCH_FILE, "utf-8");
  } catch {
    throw new Error(`Batch file not found: ${BATCH_FILE}`);
  }

  const emails = parse(content) as unknown;

  if (!Array.isArray(emails) || emails.length === 0) {
    throw new Error(`Batch file is empty or invalid: ${BATCH_FILE}`);
  }

  for (const entry of emails) {
    if (typeof entry !== "string" || !entry.includes("@")) {
      throw new Error(`Invalid email in batch file: ${String(entry)}`);
    }
  }

  return emails as string[];
}

/**
 * Run onboarding for multiple employees in parallel.
 *
 * @param parallelCount - Number of concurrent browser workers
 * @param options - Shared options (dryRun, etc.)
 */
export async function runParallel(
  parallelCount: number,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  const emails = await loadBatchFile();
  log.step(`Loaded ${emails.length} email(s) from batch file`);
  log.step(`Starting ${parallelCount} parallel worker(s)`);

  const queue = [...emails];
  const mutex = new Mutex();
  const lockedTracker = createLockedTracker(mutex);

  const workerCount = Math.min(parallelCount, emails.length);
  const workers = Array.from({ length: workerCount }, (_, i) =>
    runWorker(i + 1, queue, lockedTracker, options),
  );

  await Promise.all(workers);
  log.success(`All ${emails.length} employee(s) processed`);
}

/**
 * A single worker that processes emails from the shared queue.
 * Launches its own browser pair and reuses them across employees.
 */
async function runWorker(
  workerId: number,
  queue: string[],
  lockedTracker: (filePath: string, data: TrackerRow) => Promise<void>,
  options: { dryRun?: boolean },
): Promise<void> {
  const prefix = `[Worker ${workerId}]`;

  // Launch browser pair once per worker
  log.step(`${prefix} Launching CRM browser...`);
  const crmBrowser = await launchBrowser();

  let ucpathPage: import("playwright").Page | undefined;
  if (!options.dryRun) {
    log.step(`${prefix} Launching UCPath browser...`);
    const ucpathBrowser = await launchBrowser();
    ucpathPage = ucpathBrowser.page;
  }

  while (queue.length > 0) {
    const email = queue.shift();
    if (!email) break; // queue exhausted between check and shift
    log.step(`${prefix} Processing ${email} (${queue.length} remaining in queue)`);

    try {
      await runOnboarding(email, {
        dryRun: options.dryRun,
        crmPage: crmBrowser.page,
        ucpathPage,
        updateTrackerFn: lockedTracker,
        logPrefix: prefix,
      });
      log.success(`${prefix} Completed ${email}`);
    } catch (error) {
      log.error(`${prefix} Failed ${email}: ${errorMessage(error)}`);
      // Worker continues to next email — error already logged to tracker in workflow.ts
    }
  }

  log.success(`${prefix} Worker finished — browsers left open`);
}
```

- [ ] **Step 2: Update onboarding barrel exports**

In `src/workflows/onboarding/index.ts`, add export for parallel module. Replace contents:

```typescript
export { extractRawFields, extractRecordPageFields } from "./extract.js";
export { validateEmployeeData, EmployeeDataSchema } from "./schema.js";
export type { EmployeeData } from "./schema.js";
export { buildTransactionPlan } from "./enter.js";
export { runOnboarding } from "./workflow.js";
export type { OnboardingOptions } from "./workflow.js";
export { runParallel, loadBatchFile } from "./parallel.js";
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: Clean compilation

- [ ] **Step 4: Commit**

```bash
git add src/workflows/onboarding/parallel.ts src/workflows/onboarding/index.ts
git commit -m "feat: add parallel worker pool for batch onboarding"
```

---

### Task 15: Update CLI with --parallel option

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Replace cli.ts contents**

```typescript
import { Command } from "commander";
import { validateEnv } from "./utils/env.js";
import { log } from "./utils/log.js";
import { errorMessage } from "./utils/errors.js";
import { launchBrowser } from "./browser/launch.js";
import { loginToUCPath, loginToACTCrm } from "./auth/login.js";
import type { AuthResult } from "./auth/types.js";
import { runOnboarding, runParallel } from "./workflows/onboarding/index.js";

const program = new Command();

program
  .name("hr-auto")
  .description("UCPath HR Automation Tool")
  .version("0.1.0");

// ─── test-login ───

async function runAuthFlow(): Promise<AuthResult> {
  const result: AuthResult = { ucpath: false, actCrm: false };

  log.step("Starting UCPath authentication...");
  const ucpath = await launchBrowser();
  try {
    const ok = await loginToUCPath(ucpath.page);
    if (!ok) {
      log.error("UCPath authentication failed");
      await ucpath.browser.close();
      process.exit(1);
    }
    result.ucpath = true;
  } finally {
    await ucpath.browser.close();
  }

  log.step("Starting ACT CRM authentication...");
  const actCrm = await launchBrowser();
  try {
    const ok = await loginToACTCrm(actCrm.page);
    if (!ok) {
      log.error("ACT CRM authentication failed");
      await actCrm.browser.close();
      process.exit(1);
    }
    result.actCrm = true;
  } finally {
    await actCrm.browser.close();
  }

  log.success("Authentication complete");
  return result;
}

program
  .command("test-login")
  .description("Test authentication to UCPath and ACT CRM")
  .action(async () => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    try {
      await runAuthFlow();
    } catch (firstError) {
      log.error("Unexpected error -- retrying...");
      try {
        await runAuthFlow();
      } catch (secondError) {
        log.error(`Authentication failed after retry: ${errorMessage(secondError)}`);
        process.exit(1);
      }
    }
  });

// ─── start-onboarding ───

program
  .command("start-onboarding")
  .description("Start onboarding: extract from CRM, search UCPath, create transaction")
  .argument("[email]", "Employee email (for single-employee mode)")
  .option("--dry-run", "Preview actions without creating transaction")
  .option("--parallel <N>", "Process batch file with N parallel workers", parseInt)
  .action(async (email: string | undefined, options: { dryRun?: boolean; parallel?: number }) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    // Validate: exactly one of email or --parallel
    if (email && options.parallel) {
      log.error("Cannot use both <email> and --parallel. Use email for single mode, --parallel for batch mode.");
      process.exit(1);
    }
    if (!email && !options.parallel) {
      log.error("Provide an <email> for single mode or --parallel <N> for batch mode.");
      process.exit(1);
    }

    if (options.parallel) {
      if (options.parallel < 1 || !Number.isFinite(options.parallel)) {
        log.error("--parallel must be a positive integer.");
        process.exit(1);
      }
      await runParallel(options.parallel, { dryRun: options.dryRun });
    } else {
      await runOnboarding(email!, { dryRun: options.dryRun });
    }
  });

program.parse();
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: Clean compilation

- [ ] **Step 3: Verify CLI help output**

Run: `npx tsx src/cli.ts start-onboarding --help`
Expected: Shows `[email]` as optional arg, `--parallel <N>` and `--dry-run` as options

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add --parallel CLI option for batch onboarding"
```

---

### Task 16: Update CLAUDE.md and package.json scripts

**Files:**
- Modify: `CLAUDE.md`
- Modify: `package.json`

- [ ] **Step 1: Update package.json scripts**

In `package.json`, add the batch script after the existing `start-onboarding:dry` line:

```json
"start-onboarding:batch": "tsx --env-file=.env src/cli.ts start-onboarding --parallel",
```

This allows `npm run start-onboarding:batch -- 3` to run with 3 workers.

- [ ] **Step 2: Update CLAUDE.md commands section**

Add to the commands section after the existing onboarding commands:

```
npm run start-onboarding:batch -- <N>  # Batch onboarding with N parallel workers
```

- [ ] **Step 3: Update CLAUDE.md architecture section**

Update the tracker bullet and add download module:
- Change `tracker/` description to mention daily worksheets and workflow-specific location
- Add reference to `parallel.ts` and `download.ts` in `workflows/onboarding/`

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md package.json
git commit -m "docs: update CLAUDE.md and package.json for parallel onboarding"
```

---

### Task 17: Final verification

- [ ] **Step 1: Full typecheck**

Run: `npx tsc --noEmit`
Expected: Clean — no errors

- [ ] **Step 2: Run all tests**

Run: `npx tsx --test tests/unit/tracker.test.ts`
Expected: All tests pass

- [ ] **Step 3: Verify single-mode still works**

Run: `npx tsx --env-file=.env src/cli.ts start-onboarding --help`
Expected: Shows correct help with optional email and --parallel

- [ ] **Step 4: Verify batch validation**

Run: `npx tsx --env-file=.env src/cli.ts start-onboarding --parallel 2`
Expected: Error about empty/missing batch file (since template has no emails)
