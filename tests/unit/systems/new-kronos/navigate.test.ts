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

import { resolveSearchResult, dateDigits, maskedDigitPrefixes } from "../../../../src/systems/new-kronos/navigate.js";
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

/**
 * Pins maskedDigitPrefixes — the progressive per-keystroke digit prefixes that
 * `typeMaskedDate` types into WFD's masked date inputs ONE digit at a time,
 * waiting for the field to reflect each prefix before sending the next key.
 *
 * Regression guard for ISS-B05 (round 2): the first fix typed all 8 digits via
 * `pressSequentially(want, { delay: 60 })` — a fixed 60ms inter-key delay that
 * still RACED WFD's async React-controlled mask under the live 8-worker parallel
 * separations batch. The keystrokes outran the mask and scrambled/overflowed the
 * value: wanting "05112026", the field landed on "1120260622" (10 digits — the
 * year segment overflowed to 6 digits, interleaving today's "0622"). Condition-
 * based entry (type one digit → wait until the field's stripped digits EQUAL the
 * next prefix) removes the race: the next keystroke is never sent until the mask
 * has committed the current one.
 */
describe("maskedDigitPrefixes", () => {
  it("emits one progressive prefix per keystroke", () => {
    assert.deepEqual(maskedDigitPrefixes("05112026"), [
      "0",
      "05",
      "051",
      "0511",
      "05112",
      "051120",
      "0511202",
      "05112026",
    ]);
  });

  it("yields no prefixes for an empty digit string", () => {
    assert.deepEqual(maskedDigitPrefixes(""), []);
  });

  it("the live-log scramble matches NO prefix, so the per-digit settle rejects it (ISS-B05 round 2)", () => {
    // The field scrambled "05112026" → "1120260622" under parallel-batch load.
    // typeMaskedDate waits for the field's digits to equal each prefix before the
    // next keystroke; the scrambled state equals none of them, so the settle wait
    // times out and the attempt re-clears / retries instead of applying garbage.
    const prefixes = maskedDigitPrefixes("05112026");
    assert.equal(prefixes.includes(dateDigits("11/20/260622")), false);
    assert.equal(prefixes.includes(dateDigits("11/20/260605")), false);
    // And the final prefix is the full wanted value (what the verify compares).
    assert.equal(prefixes[prefixes.length - 1], dateDigits("05/11/2026"));
  });
});
