import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  separationsStatusExtensions,
  separationEidApprovalState,
} from "../../../src/domain/separations-status.js";

/**
 * The separations EID-approval status rule. `data.eidApproval` is stamped by the
 * identity-check pause (`"pending"`) and the dismiss action (`"dismissed"`); the
 * derived status drives the dashboard badge that replaces the base `done`.
 */
function entry(eidApproval?: string) {
  return {
    workflow: "separations",
    status: "done",
    data: eidApproval === undefined ? {} : { eidApproval },
  };
}

describe("separationEidApprovalState", () => {
  it("reads data.eidApproval, defaulting to empty string", () => {
    assert.equal(separationEidApprovalState(entry("pending")), "pending");
    assert.equal(separationEidApprovalState(entry()), "");
    assert.equal(separationEidApprovalState({}), "");
  });
});

describe("separationsStatusExtensions.derivedStatus", () => {
  const derived = (e: Parameters<NonNullable<typeof separationsStatusExtensions.derivedStatus>>[0]) =>
    separationsStatusExtensions.derivedStatus!(e);

  it("→ awaitingApproval when pending", () => {
    assert.equal(derived(entry("pending")), "awaitingApproval");
  });

  it("→ dismissed when dismissed", () => {
    assert.equal(derived(entry("dismissed")), "dismissed");
  });

  it("→ null on a normal row (no eidApproval / unknown value)", () => {
    assert.equal(derived(entry()), null);
    assert.equal(derived(entry("approved")), null, "approved re-runs are normal rows, no badge");
  });

  it("declares no secondaryTag", () => {
    assert.equal(separationsStatusExtensions.secondaryTag, undefined);
  });
});
