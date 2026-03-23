import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import ExcelJS from "exceljs";
import { parseDepartmentNumber } from "../../src/tracker/index.js";
import {
  updateOnboardingTracker,
  ONBOARDING_TRACKER_COLUMNS,
} from "../../src/workflows/onboarding/tracker.js";
import type { OnboardingTrackerRow } from "../../src/workflows/onboarding/tracker.js";

const SAMPLE_ROW: OnboardingTrackerRow = {
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

describe("updateOnboardingTracker", () => {
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
    await updateOnboardingTracker(filePath, SAMPLE_ROW);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const today = new Date().toISOString().slice(0, 10);
    const sheet = workbook.getWorksheet(today);
    assert.ok(sheet, `Sheet '${today}' should exist`);

    const headerRow = sheet.getRow(1);
    const headers = ONBOARDING_TRACKER_COLUMNS.map((col) => col.header);
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

    const row1: OnboardingTrackerRow = { ...SAMPLE_ROW, firstName: "Alice" };
    const row2: OnboardingTrackerRow = { ...SAMPLE_ROW, firstName: "Bob" };

    await updateOnboardingTracker(filePath, row1);
    await updateOnboardingTracker(filePath, row2);

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
    await updateOnboardingTracker(filePath, SAMPLE_ROW);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const today = new Date().toISOString().slice(0, 10);
    const sheet = workbook.getWorksheet(today)!;
    // SSN is column 4
    assert.equal(sheet.getRow(2).getCell(4).value, "123-45-6789");
  });
});
