import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import * as env from "../../../src/utils/env.js";
import { validateEnv, EnvValidationError, numEnv } from "../../../src/utils/env.js";

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
    assert.ok(validateI9Env, "validateI9Env should be an exported function");
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
    assert.ok(validateI9Env, "validateI9Env should be an exported function");
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
    assert.ok(validateI9Env, "validateI9Env should be an exported function");

    assert.throws(
      () => validateI9Env(),
      (err: unknown) =>
        err instanceof EnvValidationError &&
        err.message.includes("I9_PASSWORD"),
    );
  });
});

describe("numEnv", () => {
  const KEY = "__NUMENV_TEST__";

  afterEach(() => {
    delete process.env[KEY];
  });

  it("returns fallback when var is unset", () => {
    delete process.env[KEY];
    assert.equal(numEnv(KEY, 42), 42);
  });

  it("returns fallback when var is blank", () => {
    process.env[KEY] = "  ";
    assert.equal(numEnv(KEY, 99), 99);
  });

  it("returns fallback for non-numeric value", () => {
    process.env[KEY] = "abc";
    assert.equal(numEnv(KEY, 5), 5);
  });

  it("returns parsed value when valid", () => {
    process.env[KEY] = "7";
    assert.equal(numEnv(KEY, 1), 7);
  });

  it("opts.integer: rejects a float, returns fallback", () => {
    process.env[KEY] = "2.5";
    assert.equal(numEnv(KEY, 1, { integer: true }), 1);
  });

  it("opts.integer: accepts an integer", () => {
    process.env[KEY] = "3";
    assert.equal(numEnv(KEY, 1, { integer: true }), 3);
  });

  it("opts.min: rejects a value below min, returns fallback", () => {
    process.env[KEY] = "-1";
    assert.equal(numEnv(KEY, 10, { min: 0 }), 10);
  });

  it("opts.min: accepts a value equal to min", () => {
    process.env[KEY] = "0";
    assert.equal(numEnv(KEY, 10, { min: 0 }), 0);
  });

  it("opts.min=1 with integer: rejects 0, returns fallback", () => {
    process.env[KEY] = "0";
    assert.equal(numEnv(KEY, 4, { integer: true, min: 1 }), 4);
  });

  it("opts.min=1 with integer: accepts 1", () => {
    process.env[KEY] = "1";
    assert.equal(numEnv(KEY, 4, { integer: true, min: 1 }), 1);
  });

  it("opts.min=1 with integer: rejects float even above min", () => {
    process.env[KEY] = "1.5";
    assert.equal(numEnv(KEY, 4, { integer: true, min: 1 }), 4);
  });
});
