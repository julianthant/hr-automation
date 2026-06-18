import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  SURFACES,
  delegatedStatusLabel,
  parseInitialTab,
  type DelegatedChild,
} from "../../../src/dashboard/components/log-panel/LogStream.js";

// USR-001 regression pin: the "Delegated" tab must exist in the surface bar
// and must be deep-linkable via parseInitialTab, and the status label helper
// must return the correct labels (including the cancelled sentinel).
//
// RED before fix: "delegated" was not in SURFACES, and parseInitialTab("delegated")
// returned { surface: "logs", category: "all" } (the unknown-key fallback).
// GREEN after fix: SURFACES contains "delegated" and parseInitialTab routes it
// correctly to { surface: "delegated", category: "all" }.

describe("Delegated surface (USR-001)", () => {
  describe("SURFACES array", () => {
    it('contains a "delegated" surface entry (USR-001)', () => {
      const keys = SURFACES.map((s) => s.key);
      assert.ok(
        keys.includes("delegated"),
        `Expected SURFACES to include "delegated"; got [${keys.join(", ")}]`,
      );
    });

    it('labels the delegated surface "Delegated"', () => {
      const entry = SURFACES.find((s) => s.key === "delegated");
      assert.ok(entry, "delegated surface entry must exist");
      assert.equal(entry.label, "Delegated");
    });
  });

  describe("parseInitialTab — delegated deep-link (USR-001)", () => {
    it('maps "delegated" to the delegated surface with the All category', () => {
      assert.deepEqual(parseInitialTab("delegated"), {
        surface: "delegated",
        category: "all",
      });
    });

    it("still defaults unknown keys to Logs + All (regression guard)", () => {
      assert.deepEqual(parseInitialTab("nonsense"), { surface: "logs", category: "all" });
    });
  });

  describe("delegatedStatusLabel", () => {
    function child(partial: Partial<DelegatedChild>): DelegatedChild {
      return {
        workflow: "person-lookup",
        id: "alice@example.com",
        runId: "run-1",
        status: "pending",
        ...partial,
      };
    }

    it('returns "Done" for done status', () => {
      assert.equal(delegatedStatusLabel(child({ status: "done" })), "Done");
    });

    it('returns "Failed" for failed status (non-cancelled)', () => {
      assert.equal(delegatedStatusLabel(child({ status: "failed", step: "extraction" })), "Failed");
    });

    it('returns "Running" for running status', () => {
      assert.equal(delegatedStatusLabel(child({ status: "running" })), "Running");
    });

    it('returns "Pending" for pending status', () => {
      assert.equal(delegatedStatusLabel(child({ status: "pending" })), "Pending");
    });

    it('returns "Cancelled" for failed+step=cancelled (the cancellation sentinel)', () => {
      assert.equal(
        delegatedStatusLabel(child({ status: "failed", step: "cancelled" })),
        "Cancelled",
        "cancelled children (failed + step=cancelled) must show Cancelled, not Failed",
      );
    });

    it("returns the raw status for unrecognised statuses", () => {
      assert.equal(delegatedStatusLabel(child({ status: "skipped" })), "skipped");
    });
  });
});
