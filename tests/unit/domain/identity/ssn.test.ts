/**
 * Unit tests for src/domain/identity/ssn.ts
 *
 * Covers:
 *   - maskSsn: normal case masks all but last 4 digits
 *   - SSNs with fewer than 4 digits return "***"
 *   - Dashes are stripped before masking
 *   - Empty string, undefined, and null guards
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { maskSsn } from "../../../../src/domain/identity/ssn.js";

describe("maskSsn — normal 9-digit SSN", () => {
  it("masks all digits except the last 4 for a 9-digit SSN without dashes", () => {
    assert.equal(maskSsn("123456789"), "***-**-6789");
  });

  it("masks a standard dashed SSN (NNN-NN-NNNN)", () => {
    assert.equal(maskSsn("123-45-6789"), "***-**-6789");
  });

  it("correctly shows only the last 4 digits after dashes are stripped", () => {
    assert.equal(maskSsn("987-65-4321"), "***-**-4321");
  });
});

describe("maskSsn — exactly 4 digits", () => {
  it("shows those 4 digits (minimum valid last-4 case)", () => {
    assert.equal(maskSsn("1234"), "***-**-1234");
  });

  it("shows last 4 of a 5-digit number", () => {
    assert.equal(maskSsn("12345"), "***-**-2345");
  });
});

describe("maskSsn — fewer than 4 digits returns '***'", () => {
  it("returns '***' for a 3-digit string", () => {
    assert.equal(maskSsn("123"), "***");
  });

  it("returns '***' for a 2-digit string", () => {
    assert.equal(maskSsn("12"), "***");
  });

  it("returns '***' for a single digit", () => {
    assert.equal(maskSsn("1"), "***");
  });
});

describe("maskSsn — empty / null / undefined guards", () => {
  it("returns empty string for empty string input", () => {
    assert.equal(maskSsn(""), "");
  });

  it("returns empty string for undefined", () => {
    assert.equal(maskSsn(undefined), "");
  });

  it("returns empty string for null", () => {
    assert.equal(maskSsn(null), "");
  });
});

describe("maskSsn — whitespace handling", () => {
  it("does not strip whitespace (spaces are not dashes)", () => {
    // The implementation only strips dashes, not spaces.
    // A string like "   " has 3 chars after the (no-op) dash-strip → "***".
    assert.equal(maskSsn("   "), "***");
  });
});
