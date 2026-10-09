import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  asMmDdYyyy,
  isForceVerifiedOverride,
} from "../../../../src/workflows/oath-signature/workflow.js";

/**
 * Pins the two pure Edit-Data override guards on the oath-signature handler.
 *
 * `isForceVerifiedOverride` bypasses the CRM onboarding gate entirely, so its
 * allowlist must NEVER match a negative annotation — the original substring
 * regex (/verif/i) matched "Not verified"/"Unverified" and silently pushed an
 * UNVERIFIED oath into UCPath.
 */

describe("isForceVerifiedOverride", () => {
  it("accepts the exact positive tokens (case-insensitive)", () => {
    for (const v of [
      "Verified",
      "verified",
      "VERIFY",
      "override",
      "yes",
      "true",
      "approved",
      "confirm",
      "Confirmed",
      "force",
      "  Verified  ",
    ]) {
      assert.equal(isForceVerifiedOverride(v), true, `expected "${v}" to force`);
    }
  });

  it("accepts the workflow's own 'Verified (<stage>)' label carried through edit-and-resume", () => {
    assert.equal(isForceVerifiedOverride("Verified (Completed)"), true);
    assert.equal(isForceVerifiedOverride("verified (Campus Forms Approved)"), true);
  });

  it("REJECTS negations and negative workflow labels — the gate must stay on", () => {
    for (const v of [
      "Not verified",
      "not Verified",
      "Unverified",
      "unconfirmed",
      "not approved",
      "No record",
      "Not signed",
      "Not signed (Campus Forms Approved)",
      "no",
      "false",
      "Verification failed",
      "please verify",
    ]) {
      assert.equal(isForceVerifiedOverride(v), false, `expected "${v}" NOT to force`);
    }
  });

  it("rejects empty / non-string values", () => {
    assert.equal(isForceVerifiedOverride(""), false);
    assert.equal(isForceVerifiedOverride("   "), false);
    assert.equal(isForceVerifiedOverride(undefined), false);
    assert.equal(isForceVerifiedOverride(null), false);
    assert.equal(isForceVerifiedOverride(42), false);
  });
});

describe("asMmDdYyyy", () => {
  it("passes through strict MM/DD/YYYY", () => {
    assert.equal(asMmDdYyyy("07/01/2026"), "07/01/2026");
  });

  it("pads single-digit month/day (operator typing 7/1/2026 is honored, not dropped)", () => {
    assert.equal(asMmDdYyyy("7/1/2026"), "07/01/2026");
    assert.equal(asMmDdYyyy("12/3/2026"), "12/03/2026");
  });

  it("returns empty string for empty/absent values", () => {
    assert.equal(asMmDdYyyy(""), "");
    assert.equal(asMmDdYyyy("   "), "");
    assert.equal(asMmDdYyyy(undefined), "");
    assert.equal(asMmDdYyyy(null), "");
  });

  it("THROWS on a non-empty non-date value instead of silently discarding the override", () => {
    assert.throws(() => asMmDdYyyy("July 1, 2026"), /not M\/D\/YYYY/);
    assert.throws(() => asMmDdYyyy("2026-07-01"), /not M\/D\/YYYY/);
    assert.throws(() => asMmDdYyyy("garbage"), /not M\/D\/YYYY/);
  });
});
