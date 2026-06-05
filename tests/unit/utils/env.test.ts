import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import * as env from "../../../src/utils/env.js";
import { validateEnv, EnvValidationError } from "../../../src/utils/env.js";

// Store original env values for restoration
let originalUserId: string | undefined;
let originalPassword: string | undefined;
let originalI9UserId: string | undefined;
let originalI9Password: string | undefined;

describe("validateEnv", () => {
  beforeEach(() => {
    originalUserId = process.env.UCPATH_USER_ID;
    originalPassword = process.env.UCPATH_PASSWORD;
    originalI9UserId = process.env.I9_USER_ID;
    originalI9Password = process.env.I9_PASSWORD;
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
    if (originalI9UserId !== undefined) {
      process.env.I9_USER_ID = originalI9UserId;
    } else {
      delete process.env.I9_USER_ID;
    }
    if (originalI9Password !== undefined) {
      process.env.I9_PASSWORD = originalI9Password;
    } else {
      delete process.env.I9_PASSWORD;
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

  it("returns I9-specific credentials when both I9 vars are set", () => {
    process.env.UCPATH_USER_ID = "ucpath-user";
    process.env.UCPATH_PASSWORD = "ucpath-password";
    process.env.I9_USER_ID = "i9-user@ucsd.edu";
    process.env.I9_PASSWORD = "i9-password";

    const validateI9Env = (env as { validateI9Env?: () => { userId: string; password: string } })
      .validateI9Env;
    assert.equal(typeof validateI9Env, "function");
    const result = validateI9Env();

    assert.equal(result.userId, "i9-user@ucsd.edu");
    assert.equal(result.password, "i9-password");
  });

  it("falls back to UCPath credentials when I9-specific vars are absent", () => {
    process.env.UCPATH_USER_ID = "ucpath-user";
    process.env.UCPATH_PASSWORD = "ucpath-password";
    delete process.env.I9_USER_ID;
    delete process.env.I9_PASSWORD;

    const validateI9Env = (env as { validateI9Env?: () => { userId: string; password: string } })
      .validateI9Env;
    assert.equal(typeof validateI9Env, "function");
    const result = validateI9Env();

    assert.equal(result.userId, "ucpath-user");
    assert.equal(result.password, "ucpath-password");
  });

  it("throws when only one I9-specific credential is set", () => {
    process.env.UCPATH_USER_ID = "ucpath-user";
    process.env.UCPATH_PASSWORD = "ucpath-password";
    process.env.I9_USER_ID = "i9-user@ucsd.edu";
    delete process.env.I9_PASSWORD;

    const validateI9Env = (env as { validateI9Env?: () => { userId: string; password: string } })
      .validateI9Env;
    assert.equal(typeof validateI9Env, "function");

    assert.throws(
      () => validateI9Env(),
      (err: unknown) =>
        err instanceof EnvValidationError &&
        err.message.includes("I9_PASSWORD"),
    );
  });
});
