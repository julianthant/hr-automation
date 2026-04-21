import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyPlaywrightError } from "../../../src/utils/errors.js";

describe("classifyPlaywrightError", () => {
  it("classifies timeout-disabled when error mentions 'not enabled'", () => {
    const err = new Error("locator.click: Timeout 10000ms exceeded.\n  - element is not enabled");
    const result = classifyPlaywrightError(err);
    assert.strictEqual(result.kind, "timeout-disabled");
    assert.match(result.summary, /disabled/i);
  });

  it("classifies timeout-intercepted when subtree intercepts", () => {
    const err = new Error("locator.click: Timeout\n  - subtree intercepts pointer events");
    assert.strictEqual(classifyPlaywrightError(err).kind, "timeout-intercepted");
  });

  it("classifies timeout-hidden when element not visible", () => {
    const err = new Error("waitForSelector: Timeout\n  - element is not visible");
    assert.strictEqual(classifyPlaywrightError(err).kind, "timeout-hidden");
  });

  it("classifies timeout-stale for element detached", () => {
    const err = new Error("Element is no longer attached to the DOM");
    assert.strictEqual(classifyPlaywrightError(err).kind, "timeout-stale");
  });

  it("classifies navigation-interrupted", () => {
    const err = new Error("page.goto: net::ERR_ABORTED; frame was detached");
    assert.strictEqual(classifyPlaywrightError(err).kind, "navigation-interrupted");
  });

  it("classifies process-singleton", () => {
    const err = new Error("browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory");
    assert.strictEqual(classifyPlaywrightError(err).kind, "process-singleton");
  });

  it("returns generic 'timeout' for plain timeouts with no detail", () => {
    const err = new Error("locator.click: Timeout 10000ms exceeded.");
    assert.strictEqual(classifyPlaywrightError(err).kind, "timeout");
  });

  it("returns 'unknown' for non-Playwright errors", () => {
    assert.strictEqual(classifyPlaywrightError(new Error("something else")).kind, "unknown");
    assert.strictEqual(classifyPlaywrightError(null).kind, "unknown");
    assert.strictEqual(classifyPlaywrightError(undefined).kind, "unknown");
  });

  it("prioritizes navigation-interrupted over timeout-stale when both tokens present", () => {
    const err = new Error("Timeout: frame was detached during navigation");
    assert.strictEqual(classifyPlaywrightError(err).kind, "navigation-interrupted");
  });
});
