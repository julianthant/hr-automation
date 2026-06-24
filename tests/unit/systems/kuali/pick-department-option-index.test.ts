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

  // Tier 2 (2026-06-24): a UCPath description can carry a DIVISION PREFIX the
  // Kuali label lacks — e.g. UCPath "VCSA-CL ASSOCIATED STUDENTS" vs Kuali
  // "Associated Students". Match the option NAME (after the code) as a substring
  // of the UCPath description when tier-1 (desc ⊆ option) misses.
  describe("tier 2 — UCPath division prefix the Kuali label lacks", () => {
    const opts = [
      "- - -",
      "000601 - Associated Students",
      "000777 - Campus Recreation",
      "000414 - Bookstore",
    ];

    it("matches 'VCSA-CL ASSOCIATED STUDENTS' to 'Associated Students'", () => {
      assert.strictEqual(pickDepartmentOptionIndex(opts, "VCSA-CL ASSOCIATED STUDENTS"), 1);
    });

    it("matches 'VCSA CAMPUS RECREATION' to 'Campus Recreation'", () => {
      assert.strictEqual(pickDepartmentOptionIndex(opts, "VCSA CAMPUS RECREATION"), 2);
    });

    it("prefers the LONGEST (most specific) option name when several are contained", () => {
      const o = ["- - -", "001 - Recreation", "002 - Campus Recreation Services"];
      // "vcsa campus recreation services" contains both "recreation" and
      // "campus recreation services" — the longer, more specific one wins.
      assert.strictEqual(pickDepartmentOptionIndex(o, "VCSA CAMPUS RECREATION SERVICES"), 2);
    });

    it("does NOT match a short generic one-word option name (avoids mis-match)", () => {
      // "Aid" (3 chars, one word) is not 'specific' → no tier-2 match → -1.
      assert.strictEqual(
        pickDepartmentOptionIndex(["- - -", "001 - Aid"], "VCSA-CL FINANCIAL AID OFFICE"),
        -1,
      );
    });

    it("still returns -1 when no option name is contained in the description", () => {
      assert.strictEqual(pickDepartmentOptionIndex(opts, "VCSA-CL STUDENT HEALTH"), -1);
    });

    it("tier 1 still wins over tier 2 when the description is a full substring", () => {
      // Exact desc ⊆ option must take precedence over a prefix-stripped match.
      const o = ["- - -", "000414 - Bookstore", "000999 - Campus Bookstore Annex"];
      assert.strictEqual(pickDepartmentOptionIndex(o, "Bookstore"), 1);
    });
  });
});
