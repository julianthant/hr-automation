import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Locator } from "playwright";
import { safeClick, safeFill } from "../../../../src/systems/common/safe.js";

/**
 * These tests use lightweight duck-typed fakes for Playwright's Locator
 * (just the `.click()` / `.fill()` methods we call). The real Locator API
 * surface is too broad and browser-dependent to mock in a unit test.
 */
function fakeLocator(behavior: {
  click?: () => Promise<void>;
  fill?: (v: string) => Promise<void>;
}): Locator {
  return {
    click: behavior.click ?? (async () => {}),
    fill: behavior.fill ?? (async () => {}),
  } as unknown as Locator;
}

interface LogCaptureResult<T> {
  value?: T;
  error?: unknown;
  logs: string[];
}

/** Capture stdout (console.log) while running an async fn. */
async function runWithLogCapture<T>(
  fn: () => Promise<T>,
): Promise<LogCaptureResult<T>> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  const result: LogCaptureResult<T> = { logs };
  try {
    result.value = await fn();
  } catch (e) {
    result.error = e;
  } finally {
    console.log = origLog;
  }
  return result;
}

describe("safeClick", () => {
  it("succeeds silently when the underlying click resolves", async () => {
    const loc = fakeLocator({ click: async () => {} });
    const { logs, error } = await runWithLogCapture(() =>
      safeClick(loc, { label: "test-primary" }),
    );
    assert.equal(error, undefined, "click should not throw");
    assert.equal(
      logs.filter((l) => l.includes("selector fallback")).length,
      0,
      "no fallback warning on success",
    );
  });

  it("logs 'selector fallback triggered' and re-throws on timeout", async () => {
    const clickErr = new Error("TimeoutError: locator.click timed out");
    const loc = fakeLocator({
      click: async () => {
        throw clickErr;
      },
    });
    const { logs, error } = await runWithLogCapture(() =>
      safeClick(loc, { label: "comp-rate-code" }),
    );
    assert.equal(error, clickErr, "original click error should be re-thrown");
    assert.ok(
      logs.some((l) =>
        l.includes("selector fallback triggered: comp-rate-code"),
      ),
      `expected fallback-triggered warning for label, got:\n  ${logs.join("\n  ")}`,
    );
  });
});

describe("safeFill", () => {
  it("succeeds silently when the underlying fill resolves", async () => {
    const loc = fakeLocator({ fill: async () => {} });
    const { logs, error } = await runWithLogCapture(() =>
      safeFill(loc, "v", { label: "any" }),
    );
    assert.equal(error, undefined);
    assert.equal(logs.filter((l) => l.includes("selector fallback")).length, 0);
  });

  it("logs 'selector fallback triggered' and re-throws on timeout", async () => {
    const fillErr = new Error("TimeoutError: locator.fill timed out");
    const loc = fakeLocator({
      fill: async () => {
        throw fillErr;
      },
    });
    const { logs, error } = await runWithLogCapture(() =>
      safeFill(loc, "x", { label: "national-id" }),
    );
    assert.equal(error, fillErr);
    assert.ok(
      logs.some((l) =>
        l.includes("selector fallback triggered: national-id"),
      ),
      `expected fallback-triggered warning for label`,
    );
  });
});
