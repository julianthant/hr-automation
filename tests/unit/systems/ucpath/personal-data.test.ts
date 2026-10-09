import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { isEmergencyContactPrimaryConflictMessage } from "../../../../src/systems/ucpath/personal-data.js";

describe("isEmergencyContactPrimaryConflictMessage", () => {
  it("detects the PeopleSoft primary-contact validation message", () => {
    assert.equal(
      isEmergencyContactPrimaryConflictMessage(
        "Only one emergency contact can be indicated as the primary contact. (1000,110)",
      ),
      true,
    );
  });

  it("detects the error code alone", () => {
    assert.equal(isEmergencyContactPrimaryConflictMessage("Save failed (1000,110)"), true);
  });

  it("does not match unrelated save errors", () => {
    assert.equal(
      isEmergencyContactPrimaryConflictMessage("Session timeout — please sign in again"),
      false,
    );
  });
});
