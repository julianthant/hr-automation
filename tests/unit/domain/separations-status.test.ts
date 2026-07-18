import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  separationsStatusExtensions,
  separationEidApprovalState,
  i9CheckResultTag,
} from "../../../src/domain/separations-status.js";

/**
 * The separations EID-approval status rule. `data.eidApproval` is stamped by the
 * identity-check pause (`"pending"`) and the dismiss action (`"dismissed"`); the
 * derived status drives the dashboard badge that replaces the base `done`.
 */
function entry(eidApproval?: string) {
  const data: Record<string, string> = {};
  if (eidApproval !== undefined) data.eidApproval = eidApproval;
  return { workflow: "separations", status: "done", data };
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

  it("→ null on an I-9 check result row (that rule is a TAG, not a derived badge)", () => {
    assert.equal(derived({ workflow: "separations", status: "done", data: { ucpathFound: "false" } }), null);
  });
});

/**
 * The second, independent separations rule: the UCPath found / not-found chip on
 * the per-person member rows fanned back from a "Run I-9 Check" operation. It
 * rides `secondaryTag` (a chip BESIDE the done/failed badge), so it composes
 * with the EID-approval `derivedStatus` above rather than replacing it.
 */
describe("separationsStatusExtensions.secondaryTag — the I-9 check result chip", () => {
  const tag = (data: Record<string, string>) =>
    separationsStatusExtensions.secondaryTag!({ workflow: "separations", status: "done", data }, { isDone: true });

  it("→ 'In UCPath' when the person search matched", () => {
    assert.equal(tag({ ucpathFound: "true" })?.text, "In UCPath");
    assert.match(tag({ ucpathFound: "true" })!.className, /success/);
  });

  it("→ 'Not in UCPath' on a definitive no-match", () => {
    assert.equal(tag({ ucpathFound: "false" })?.text, "Not in UCPath");
    assert.match(tag({ ucpathFound: "false" })!.className, /warning/);
  });

  it("→ NO chip when the check never answered — an unanswered search is not a not-found", () => {
    assert.equal(tag({}), null);
    assert.equal(tag({ ucpathFound: "" }), null);
    assert.equal(tag({ eidApproval: "pending" }), null, "an ordinary separations row carries no chip");
  });

  it("i9CheckResultTag is the same rule, exported for direct use", () => {
    assert.equal(i9CheckResultTag({ data: { ucpathFound: "true" } })?.text, "In UCPath");
    assert.equal(i9CheckResultTag({}), null);
  });
});
