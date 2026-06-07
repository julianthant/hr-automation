import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import {
  extractField,
  stripLabel,
  labelVariants,
  type CrmRecordFieldSelectors,
} from "../../../../src/systems/crm/extract.js";

/**
 * Unit tests for CRM `extractField` robustness + its pure label helpers.
 *
 * `extractField` drives Playwright `Locator`s from the `record` selector
 * registry. We pass a FAKE registry (`extractField`'s injectable `selectors`
 * param) whose locators resolve against an in-memory `(strategy, label) -> text`
 * store — a fake DOM — instead of a live page. This lets us assert the ordering
 * (verified Visualforce strategies win first, broad fallbacks only fill gaps),
 * the with/without-colon label variants, and label stripping, all PII-free with
 * synthetic data and no browser.
 */

// Keyed by `${strategy}|${label}` → the text a `.first().textContent()` would
// return. Missing key = the locator throws (no match), mirroring a
// `.textContent({ timeout })` that times out on a real page.
const store = new Map<string, string>();

function fakeRegistry(): CrmRecordFieldSelectors {
  const make = (strategy: string) =>
    ((_page: unknown, label: string) =>
      ({
        first() {
          return {
            async textContent() {
              const key = `${strategy}|${label}`;
              if (store.has(key)) return store.get(key)!;
              throw new Error("no match (fake locator)");
            },
          };
        },
      })) as unknown as CrmRecordFieldSelectors["thLabelFollowingTd"];
  return {
    thLabelFollowingTd: make("thLabelFollowingTd"),
    tdLabelFollowingTd: make("tdLabelFollowingTd"),
    cellLabelFollowingTd: make("cellLabelFollowingTd"),
    rowLabelLastCell: make("rowLabelLastCell"),
    lightningFieldValue: make("lightningFieldValue"),
  };
}

const PAGE = {} as never;
const FAKE = fakeRegistry();
const extract = (label: string): Promise<string | null> =>
  extractField(PAGE, label, FAKE);

beforeEach(() => {
  store.clear();
});

describe("stripLabel", () => {
  it("strips a leading label without a colon", () => {
    assert.equal(stripLabel("Date Signed 11/1/2021 1:47 PM", "Date Signed"), "11/1/2021 1:47 PM");
  });
  it("strips a leading label with a colon", () => {
    assert.equal(stripLabel("Date Signed: 11/1/2021", "Date Signed"), "11/1/2021");
  });
  it("is case-insensitive on the label", () => {
    assert.equal(stripLabel("DATE SIGNED  4/1/26", "Date Signed"), "4/1/26");
  });
  it("leaves a value that does not start with the label untouched", () => {
    assert.equal(stripLabel("11/1/2021", "Date Signed"), "11/1/2021");
  });
  it("does not strip a non-leading label occurrence", () => {
    assert.equal(stripLabel("11/1 Date Signed", "Date Signed"), "11/1 Date Signed");
  });
});

describe("labelVariants", () => {
  it("adds a colon variant for a label without one", () => {
    assert.deepEqual(labelVariants("Date Signed"), ["Date Signed", "Date Signed:"]);
  });
  it("does not double a colon when the label already ends in one", () => {
    assert.deepEqual(labelVariants("Date Signed:"), ["Date Signed:"]);
  });
  it("trims surrounding whitespace", () => {
    assert.deepEqual(labelVariants("  First Day of Service  "), [
      "First Day of Service",
      "First Day of Service:",
    ]);
  });
});

describe("extractField", () => {
  it("returns the verified th-strategy value first when present", async () => {
    store.set("thLabelFollowingTd|Date Signed", "11/1/2021 1:47 PM");
    // A fallback would return a wrong value — must NOT be reached.
    store.set("rowLabelLastCell|Date Signed", "WRONG");
    assert.equal(await extract("Date Signed"), "11/1/2021 1:47 PM");
  });

  it("falls back to the td strategy when th misses", async () => {
    store.set("tdLabelFollowingTd|Date Signed", "11/1/2021");
    assert.equal(await extract("Date Signed"), "11/1/2021");
  });

  it("falls back to the broad any-cell strategy when th + td miss", async () => {
    store.set("cellLabelFollowingTd|Date Signed", "11/1/2021");
    assert.equal(await extract("Date Signed"), "11/1/2021");
  });

  it("falls back to the row-last-cell strategy and strips the label", async () => {
    // Same-cell label+value (e.g. tr:has-text(...) td:last-child) → strip label.
    store.set("rowLabelLastCell|Date Signed", "Date Signed 11/1/2021 1:47 PM");
    assert.equal(await extract("Date Signed"), "11/1/2021 1:47 PM");
  });

  it("falls back to the Lightning field-value strategy", async () => {
    store.set("lightningFieldValue|First Day of Service", "2021-11-01");
    assert.equal(await extract("First Day of Service"), "2021-11-01");
  });

  it("matches the colon label variant when only that form is present", async () => {
    store.set("thLabelFollowingTd|Date Signed:", "11/1/2021");
    assert.equal(await extract("Date Signed"), "11/1/2021");
  });

  it("returns null when no strategy or variant matches", async () => {
    assert.equal(await extract("Date Signed"), null);
  });

  it("skips an empty cell and keeps trying later strategies", async () => {
    store.set("thLabelFollowingTd|Date Signed", "   ");
    store.set("cellLabelFollowingTd|Date Signed", "11/1/2021");
    assert.equal(await extract("Date Signed"), "11/1/2021");
  });
});
