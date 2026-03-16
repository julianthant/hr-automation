import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import ExcelJS from "exceljs";
import {
  maskSsn,
  parseDepartmentNumber,
  updateTracker,
  TRACKER_COLUMNS,
} from "../../src/tracker/index.js";
import type { TrackerRow } from "../../src/tracker/index.js";

const SAMPLE_ROW: TrackerRow = {
  firstName: "Jane",
  lastName: "Doe",
  ssnMasked: "XXX-XX-6789",
  dob: "01/15/1990",
  departmentNumber: "000412",
  recruitmentNumber: "REQ-12345",
  rehire: "No",
  effectiveDate: "01/15/2026",
  crmExtracted: "Done",
  personSearch: "Done",
  transaction: "Pending",
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

describe("maskSsn", () => {
  it('masks "123-45-6789" to "XXX-XX-6789"', () => {
    assert.equal(maskSsn("123-45-6789"), "XXX-XX-6789");
  });

  it('returns "N/A" for undefined', () => {
    assert.equal(maskSsn(undefined), "N/A");
  });

  it('returns "N/A" for empty string', () => {
    assert.equal(maskSsn(""), "N/A");
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

  it('creates new .xlsx with "Onboarding Tracker" sheet and 11 column headers when file does not exist', async () => {
    const filePath = tempPath();
    await updateTracker(filePath, SAMPLE_ROW);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const sheet = workbook.getWorksheet("Onboarding Tracker");
    assert.ok(sheet, "Sheet 'Onboarding Tracker' should exist");

    // Verify 11 column headers
    const headerRow = sheet.getRow(1);
    const headers = TRACKER_COLUMNS.map((col) => col.header);
    assert.equal(headers.length, 11, "Should have 11 columns defined");

    for (let i = 0; i < headers.length; i++) {
      assert.equal(
        headerRow.getCell(i + 1).value,
        headers[i],
        `Column ${i + 1} header should be "${headers[i]}"`,
      );
    }
  });

  it("appends row to existing .xlsx without losing previous rows", async () => {
    const filePath = tempPath();

    const row1: TrackerRow = { ...SAMPLE_ROW, firstName: "Alice" };
    const row2: TrackerRow = { ...SAMPLE_ROW, firstName: "Bob" };

    await updateTracker(filePath, row1);
    await updateTracker(filePath, row2);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const sheet = workbook.getWorksheet("Onboarding Tracker");
    assert.ok(sheet, "Sheet should exist");

    // 1 header row + 2 data rows = 3 rows
    assert.equal(sheet.rowCount, 3, "Should have 3 rows (1 header + 2 data)");

    // Verify both data rows present
    assert.equal(sheet.getRow(2).getCell(1).value, "Alice");
    assert.equal(sheet.getRow(3).getCell(1).value, "Bob");
  });
});
