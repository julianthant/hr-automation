import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getSsoFieldSelectors } from "../../src/auth/sso-fields.js";

describe("getSsoFieldSelectors", () => {
  it("returns username labels array with 3 elements", () => {
    const selectors = getSsoFieldSelectors();
    assert.ok(Array.isArray(selectors.usernameLabels), "usernameLabels should be an array");
    assert.equal(selectors.usernameLabels.length, 3);
  });

  it("returns correct username labels in order", () => {
    const selectors = getSsoFieldSelectors();
    assert.equal(selectors.usernameLabels[0], "User name (or email address)");
    assert.equal(selectors.usernameLabels[1], "Username");
    assert.equal(selectors.usernameLabels[2], 'input[name="j_username"]');
  });

  it("returns password labels array with 3 elements", () => {
    const selectors = getSsoFieldSelectors();
    assert.ok(Array.isArray(selectors.passwordLabels), "passwordLabels should be an array");
    assert.equal(selectors.passwordLabels.length, 3);
  });

  it("returns correct password labels in order", () => {
    const selectors = getSsoFieldSelectors();
    assert.equal(selectors.passwordLabels[0], "Password:");
    assert.equal(selectors.passwordLabels[1], "Password");
    assert.equal(selectors.passwordLabels[2], 'input[name="j_password"]');
  });

  it("returns the correct submit button selector", () => {
    const selectors = getSsoFieldSelectors();
    assert.equal(selectors.submitSelector, 'button[name="_eventId_proceed"]');
  });
});
