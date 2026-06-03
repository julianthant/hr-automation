/**
 * Unit tests for src/workflows/work-study/schema.ts
 *
 * Covers: WorkStudyInputSchema regex validators for emplId and effectiveDate,
 * including boundary values, empty inputs, and malformed inputs.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { WorkStudyInputSchema } from "../../../../src/workflows/work-study/schema.js";

describe("WorkStudyInputSchema — emplId regex (^\\d{5,}$)", () => {
  it("accepts a 5-digit employee ID (lower boundary)", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "12345", effectiveDate: "01/01/2024" });
    assert.equal(result.success, true);
  });

  it("accepts a 6-digit employee ID", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "123456", effectiveDate: "01/01/2024" });
    assert.equal(result.success, true);
  });

  it("accepts a long (10-digit) employee ID", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "1234567890", effectiveDate: "01/01/2024" });
    assert.equal(result.success, true);
  });

  it("rejects a 4-digit employee ID (below minimum length)", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "1234", effectiveDate: "01/01/2024" });
    assert.equal(result.success, false);
  });

  it("rejects a 1-digit employee ID", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "1", effectiveDate: "01/01/2024" });
    assert.equal(result.success, false);
  });

  it("rejects an empty string employee ID", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "", effectiveDate: "01/01/2024" });
    assert.equal(result.success, false);
  });

  it("rejects an employee ID with letters", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "1234A", effectiveDate: "01/01/2024" });
    assert.equal(result.success, false);
  });

  it("rejects an employee ID with leading spaces", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: " 12345", effectiveDate: "01/01/2024" });
    assert.equal(result.success, false);
  });

  it("rejects an employee ID with trailing spaces", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "12345 ", effectiveDate: "01/01/2024" });
    assert.equal(result.success, false);
  });

  it("rejects an employee ID with dashes", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "123-45", effectiveDate: "01/01/2024" });
    assert.equal(result.success, false);
  });
});

describe("WorkStudyInputSchema — effectiveDate regex (^\\d{2}/\\d{2}/\\d{4}$)", () => {
  it("accepts a valid MM/DD/YYYY date", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "12345", effectiveDate: "03/17/2026" });
    assert.equal(result.success, true);
  });

  it("accepts 01/01/2000 (minimum-looking date)", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "12345", effectiveDate: "01/01/2000" });
    assert.equal(result.success, true);
  });

  it("accepts 12/31/9999 (maximum-looking date)", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "12345", effectiveDate: "12/31/9999" });
    assert.equal(result.success, true);
  });

  it("rejects YYYY-MM-DD format (ISO 8601)", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "12345", effectiveDate: "2026-03-17" });
    assert.equal(result.success, false);
  });

  it("rejects a date with only 1-digit month", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "12345", effectiveDate: "3/17/2026" });
    assert.equal(result.success, false);
  });

  it("rejects a date with only 1-digit day", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "12345", effectiveDate: "03/7/2026" });
    assert.equal(result.success, false);
  });

  it("rejects a date with only 2-digit year", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "12345", effectiveDate: "03/17/26" });
    assert.equal(result.success, false);
  });

  it("rejects an empty string effective date", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "12345", effectiveDate: "" });
    assert.equal(result.success, false);
  });

  it("rejects a date with slashes replaced by dashes", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "12345", effectiveDate: "03-17-2026" });
    assert.equal(result.success, false);
  });

  it("rejects a date with letters", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "12345", effectiveDate: "March/17/2026" });
    assert.equal(result.success, false);
  });

  it("rejects a date with trailing whitespace", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "12345", effectiveDate: "03/17/2026 " });
    assert.equal(result.success, false);
  });
});

describe("WorkStudyInputSchema — combined validation", () => {
  it("succeeds with valid emplId and effectiveDate together", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "98765", effectiveDate: "06/01/2026" });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.emplId, "98765");
      assert.equal(result.data.effectiveDate, "06/01/2026");
    }
  });

  it("fails when both fields are invalid", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "bad", effectiveDate: "bad" });
    assert.equal(result.success, false);
  });

  it("fails when emplId is missing", () => {
    const result = WorkStudyInputSchema.safeParse({ effectiveDate: "01/01/2024" });
    assert.equal(result.success, false);
  });

  it("fails when effectiveDate is missing", () => {
    const result = WorkStudyInputSchema.safeParse({ emplId: "12345" });
    assert.equal(result.success, false);
  });
});
