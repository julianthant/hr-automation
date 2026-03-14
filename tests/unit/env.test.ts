import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { validateEnv, EnvValidationError } from "../../src/utils/env.js";

// Store original env values for restoration
let originalUserId: string | undefined;
let originalPassword: string | undefined;

describe("validateEnv", () => {
  beforeEach(() => {
    originalUserId = process.env.UCPATH_USER_ID;
    originalPassword = process.env.UCPATH_PASSWORD;
  });

  afterEach(() => {
    // Restore original env values
    if (originalUserId !== undefined) {
      process.env.UCPATH_USER_ID = originalUserId;
    } else {
      delete process.env.UCPATH_USER_ID;
    }
    if (originalPassword !== undefined) {
      process.env.UCPATH_PASSWORD = originalPassword;
    } else {
      delete process.env.UCPATH_PASSWORD;
    }
  });

  it("throws when UCPATH_USER_ID is missing", () => {
    delete process.env.UCPATH_USER_ID;
    process.env.UCPATH_PASSWORD = "test-password";

    assert.throws(
      () => validateEnv(),
      (err: unknown) => {
        return (
          err instanceof EnvValidationError &&
          err.message.includes("UCPATH_USER_ID")
        );
      },
    );
  });

  it("throws when UCPATH_PASSWORD is missing", () => {
    process.env.UCPATH_USER_ID = "test-user";
    delete process.env.UCPATH_PASSWORD;

    assert.throws(
      () => validateEnv(),
      (err: unknown) => {
        return (
          err instanceof EnvValidationError &&
          err.message.includes("UCPATH_PASSWORD")
        );
      },
    );
  });

  it("returns credentials when both vars are set", () => {
    process.env.UCPATH_USER_ID = "test-user";
    process.env.UCPATH_PASSWORD = "test-password";

    const result = validateEnv();

    assert.equal(result.userId, "test-user");
    assert.equal(result.password, "test-password");
  });
});
