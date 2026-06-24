/**
 * Regression guard for ISS-B05 (2026-06-22 live separations batch): the Kuali
 * Final Transactions department `<select>` was filled with
 * `selectOption({ label })` using the raw `allTextContents()` string. Live UCSD
 * options carry irregular internal whitespace — `"000719 -  Supply Chain
 * Services"` has a DOUBLE space after the code dash — which never matched
 * Playwright's exact label compare, so the select timed out at 5s and the run
 * failed at `ucpath-job-summary` (5/23 docs that day). Options with a single
 * space (`"000412 - Housing/Dining/Hospitality"`) succeeded.
 *
 * Fix: select by INDEX. `pickDepartmentOptionIndex` is the pure core — it
 * resolves the matching option's index (whitespace-collapsed, case-insensitive
 * substring, skipping the `"- - -"` placeholder) so the caller can pass
 * `selectOption({ index })` and sidestep label/whitespace matching entirely.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { pickDepartmentOptionIndex } from "../../../../src/systems/kuali/navigate.js";

describe("pickDepartmentOptionIndex", () => {
  const options = [
    "- - -",
    "000412 - Housing/Dining/Hospitality",
    "000414 - Bookstore",
    "000719 -  Supply Chain Services", // double space — the ISS-B05 culprit
  ];

  it("matches an option with irregular internal whitespace (the double-space dept)", () => {
    assert.strictEqual(
      pickDepartmentOptionIndex(options, "Supply Chain Services"),
      3,
      "must resolve the double-space option that selectOption({label}) could not match",
    );
  });

  it("matches single-space options (the depts that already worked)", () => {
    assert.strictEqual(pickDepartmentOptionIndex(options, "Housing/Dining/Hospitality"), 1);
    assert.strictEqual(pickDepartmentOptionIndex(options, "Bookstore"), 2);
  });

  it("is case-insensitive and whitespace-insensitive on the needle", () => {
    assert.strictEqual(pickDepartmentOptionIndex(options, "  supply   chain   services "), 3);
    assert.strictEqual(pickDepartmentOptionIndex(options, "BOOKSTORE"), 2);
  });

  it("returns -1 when nothing matches", () => {
    assert.strictEqual(pickDepartmentOptionIndex(options, "Nonexistent Dept"), -1);
  });

  it("returns -1 for an empty/whitespace-only department (never selects the placeholder)", () => {
    assert.strictEqual(pickDepartmentOptionIndex(options, ""), -1);
    assert.strictEqual(pickDepartmentOptionIndex(options, "   "), -1);
  });

  it("skips the '- - -' placeholder row even if it would substring-match", () => {
    assert.strictEqual(pickDepartmentOptionIndex(["- - -", "100 - Real Dept"], "- - -"), -1);
  });

  it("returns the FIRST matching option when several contain the needle", () => {
    const dupes = ["- - -", "001 - Services East", "002 - Services West"];
    assert.strictEqual(pickDepartmentOptionIndex(dupes, "Services"), 1);
  });
});
