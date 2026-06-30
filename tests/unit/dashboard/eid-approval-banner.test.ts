import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  candidateDetail,
  isValidEid,
} from "../../../src/dashboard/components/log-panel/EidApprovalBanner.js";

describe("candidateDetail", () => {
  it("puts title before dept, joined with ·", () => {
    assert.equal(candidateDetail("HR", "Director"), "Director · HR");
  });

  it("filters out blank dept", () => {
    assert.equal(candidateDetail("", "Director"), "Director");
  });

  it("filters out blank title", () => {
    assert.equal(candidateDetail("HR", ""), "HR");
  });

  it("returns empty string when both fields are blank", () => {
    assert.equal(candidateDetail("", ""), "");
  });

  it("filters out whitespace-only fields", () => {
    assert.equal(candidateDetail("  ", "Director"), "Director");
  });

  it("returns empty string when both args are undefined", () => {
    assert.equal(candidateDetail(undefined, undefined), "");
  });
});

describe("isValidEid", () => {
  it("returns true for a valid 8-digit EID", () => {
    assert.equal(isValidEid("12345678"), true);
  });

  it("returns false for empty string", () => {
    assert.equal(isValidEid(""), false);
  });

  it("returns false for a 7-digit string", () => {
    assert.equal(isValidEid("1234567"), false);
  });

  it("returns false for a 9-digit string", () => {
    assert.equal(isValidEid("123456789"), false);
  });

  it("returns false for N/A", () => {
    assert.equal(isValidEid("N/A"), false);
  });

  it("returns false for a string with leading/trailing spaces", () => {
    // candidate EID check does not trim — spaces break the pattern
    assert.equal(isValidEid(" 12345678"), false);
    assert.equal(isValidEid("12345678 "), false);
  });
});
