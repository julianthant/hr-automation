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

import { resolveSearchResult } from "../../../../src/systems/new-kronos/navigate.js";
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
