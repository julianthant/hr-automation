import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Capture console output
let logOutput: string[] = [];
let errorOutput: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;

describe("log", () => {
  beforeEach(() => {
    logOutput = [];
    errorOutput = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: unknown[]) => {
      logOutput.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      errorOutput.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  it("log.step() output does not contain any env var value", async () => {
    // Set known dummy values
    const origUser = process.env.UCPATH_USER_ID;
    const origPass = process.env.UCPATH_PASSWORD;
    process.env.UCPATH_USER_ID = "SENTINEL_USER_XYZ";
    process.env.UCPATH_PASSWORD = "SENTINEL_PASS_ABC";

    const { log } = await import("../../../src/utils/log.js");
    log.step("Entering credentials...");

    const allOutput = logOutput.join("\n");
    assert.ok(
      !allOutput.includes("SENTINEL_USER_XYZ"),
      "Output must not contain user ID value",
    );
    assert.ok(
      !allOutput.includes("SENTINEL_PASS_ABC"),
      "Output must not contain password value",
    );

    // Restore
    if (origUser !== undefined) process.env.UCPATH_USER_ID = origUser;
    else delete process.env.UCPATH_USER_ID;
    if (origPass !== undefined) process.env.UCPATH_PASSWORD = origPass;
    else delete process.env.UCPATH_PASSWORD;
  });

  it("log.success, log.error, log.waiting produce output", async () => {
    const { log } = await import("../../../src/utils/log.js");

    log.success("Operation completed");
    assert.ok(logOutput.length > 0, "log.success should produce output");
    assert.ok(
      logOutput.some((line) => line.includes("Operation completed")),
      "log.success output should contain the message",
    );

    log.waiting("Please wait...");
    assert.ok(
      logOutput.some((line) => line.includes("Please wait...")),
      "log.waiting output should contain the message",
    );

    log.error("Something failed");
    assert.ok(errorOutput.length > 0, "log.error should produce output on stderr");
    assert.ok(
      errorOutput.some((line) => line.includes("Something failed")),
      "log.error output should contain the message",
    );
  });
});
