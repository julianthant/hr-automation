/**
 * Pins resolveSearchResult — the New Kronos employee-search outcome resolver.
 *
 * Regression guard for ISS-B04 (surfaced by the live separations e2e): a New
 * Kronos search for an employee with no usable record timed out after 15s and
 * THREW `[New Kronos] Timed out waiting for search results`, a fatal-looking `✗`
 * even though New Kronos is a BEST-EFFORT source (the separations handler falls
 * back to the Kuali Last Day Worked when New Kronos returns nothing). The race
 * now resolves a both-waiters-rejected timeout to NOT FOUND (`false`) with a
 * `log.warn`, not a throw.
 */

import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";

import { resolveSearchResult, dateDigits } from "../../../../src/systems/new-kronos/navigate.js";
import { log } from "../../../../src/utils/log.js";

describe("resolveSearchResult", () => {
  it("returns true when the result checkbox appears first", async () => {
    const result = await resolveSearchResult(
      Promise.resolve(), // checkbox visible
      new Promise(() => {}), // no-results sentinel never appears
      "10000001",
    );
    assert.equal(result, true);
  });

  it("returns false when the no-results sentinel appears first", async () => {
    const result = await resolveSearchResult(
      new Promise(() => {}), // checkbox never appears
      Promise.resolve(), // "no items to display"
      "10000002",
    );
    assert.equal(result, false);
  });

  it("treats a timeout (neither waiter resolves) as NOT FOUND, never throws (ISS-B04)", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const result = await resolveSearchResult(
        Promise.reject(new Error("checkbox timeout")),
        Promise.reject(new Error("no-results timeout")),
        "10000003",
      );
      assert.equal(result, false, "a both-rejected race resolves to not-found, not a throw");
      assert.ok(warn.mock.calls.length >= 1, "the best-effort miss is logged as a warning");
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * Pins dateDigits — the separator-stripped digit string that `typeMaskedDate`
 * types into and verifies against WFD's masked date inputs. The inputs
 * auto-insert "/" themselves and may drop the month's leading zero on display,
 * so entry + readback are compared on digits only. Regression guard for ISS-B05
 * (a correct "05/10/2026" got scrambled to "6/05/1020" when the literal slashes
 * were typed into the auto-masking field, tripping WFP-00889).
 */
describe("dateDigits", () => {
  it("normalizes a zero-padded MM/DD/YYYY date to MMDDYYYY", () => {
    assert.equal(dateDigits("05/10/2026"), "05102026");
  });

  it("pads each component, so input padding never matters", () => {
    // The caller (computeKronosDateRange) zero-pads, but a non-padded month/day
    // must still type the same 8 digits into the 2-slot mask.
    assert.equal(dateDigits("5/10/2026"), "05102026");
    assert.equal(dateDigits("6/5/2026"), "06052026");
  });

  it("matches a WFD readback that drops the month's leading zero", () => {
    // WFD displays/returns the month non-padded ("6/05/2026"); the verify path
    // compares it to the zero-padded wanted value via dateDigits on both sides.
    assert.equal(dateDigits("6/05/2026"), dateDigits("06/05/2026"));
  });

  it("ignores surrounding whitespace", () => {
    assert.equal(dateDigits(" 06 / 05 / 2026 "), "06052026");
  });

  it("exposes the scramble that motivated the fix as a digit mismatch", () => {
    // The wanted value vs. the scrambled "6/05/1020" the field actually held —
    // typeMaskedDate's readback compares these and retries / fails loud (ISS-B05).
    assert.notEqual(dateDigits("6/05/1020"), dateDigits("05/10/2026"));
  });
});
