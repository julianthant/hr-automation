import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator } from "playwright";
import { safeClick, safeFill } from "../../../../src/systems/common/safe.js";
import { withLogContext } from "../../../../src/utils/log.js";

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
  /** Stdout + stderr lines emitted synchronously by `log.*`. */
  stdio: string[];
  /** Parsed JSONL entries emitted into the run's tmp log dir. */
  entries: { level: string; message: string }[];
}

/**
 * Run an async fn wrapped in `withLogContext` so `log.*` calls emit JSONL
 * into a tmp dir, and also capture stdout/stderr so we can observe the
 * human-facing log prefixes. The JSONL path is authoritative because
 * `log.debug` only writes to stdout when `DEBUG=true` (gated at module
 * load), but it ALWAYS writes to JSONL when a log context exists.
 */
async function runWithLogCapture<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<LogCaptureResult<T>> {
  const stdio: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    stdio.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    stdio.push(args.join(" "));
  };
  const dir = mkdtempSync(join(tmpdir(), "safe-test-"));
  const result: LogCaptureResult<T> = { stdio, entries: [] };
  try {
    result.value = await withLogContext("test-wf", label, fn, dir);
  } catch (e) {
    result.error = e;
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const contents = readFileSync(join(dir, file), "utf-8");
      for (const line of contents.split("\n").filter(Boolean)) {
        const parsed = JSON.parse(line) as { level: string; message: string };
        result.entries.push({ level: parsed.level, message: parsed.message });
      }
    }
  }
  return result;
}

describe("safeClick", () => {
  it("logs a debug timing line on quick success (no fallback warning)", async () => {
    const loc = fakeLocator({ click: async () => {} });
    const { stdio, entries, error } = await runWithLogCapture("t1", () =>
      safeClick(loc, { label: "test-primary" }),
    );
    assert.equal(error, undefined, "click should not throw");
    assert.equal(
      stdio.filter((l) => l.includes("selector fallback")).length,
      0,
      "no fallback warning on quick success",
    );
    assert.ok(
      entries.some(
        (e) =>
          e.level === "debug" &&
          /test-primary: clicked in \d+ms/.test(e.message),
      ),
      `expected a debug timing entry, got:\n  ${entries.map((e) => `${e.level}: ${e.message}`).join("\n  ")}`,
    );
  });

  it("logs a fallback-triggered warning when the click is slow", async () => {
    const loc = fakeLocator({
      click: async () => {
        await new Promise((r) => setTimeout(r, 60));
      },
    });
    const { stdio, entries, error } = await runWithLogCapture("t2", () =>
      safeClick(loc, { label: "slow-primary", _slowThresholdMs: 50 }),
    );
    assert.equal(error, undefined, "slow click should still succeed");
    assert.ok(
      stdio.some((l) =>
        /selector fallback triggered: slow-primary \(click took \d+ms — likely fallback-hit or page stall\)/.test(
          l,
        ),
      ),
      `expected slow-success fallback warning on stdout, got:\n  ${stdio.join("\n  ")}`,
    );
    assert.ok(
      entries.some(
        (e) => e.level === "warn" && e.message.includes("selector fallback triggered: slow-primary"),
      ),
      "expected matching warn entry in JSONL",
    );
  });

  it("logs a unified 'selector fallback triggered' error with timing and re-throws on failure", async () => {
    const clickErr = new Error("TimeoutError: locator.click timed out");
    const loc = fakeLocator({
      click: async () => {
        throw clickErr;
      },
    });
    const { stdio, entries, error } = await runWithLogCapture("t3", () =>
      safeClick(loc, { label: "comp-rate-code" }),
    );
    assert.equal(error, clickErr, "original click error should be re-thrown");
    assert.ok(
      stdio.some((l) =>
        /selector fallback triggered: comp-rate-code \(click failed after \d+ms — TimeoutError: locator\.click timed out\)/.test(
          l,
        ),
      ),
      `expected unified error line with timing + message, got:\n  ${stdio.join("\n  ")}`,
    );
    assert.ok(
      entries.some(
        (e) =>
          e.level === "error" &&
          /selector fallback triggered: comp-rate-code \(click failed after \d+ms/.test(
            e.message,
          ),
      ),
      "expected matching error entry in JSONL (shares the 'selector fallback triggered' marker)",
    );
  });
});

describe("safeFill", () => {
  it("logs a debug timing line on quick success (no fallback warning)", async () => {
    const loc = fakeLocator({ fill: async () => {} });
    const { stdio, entries, error } = await runWithLogCapture("t4", () =>
      safeFill(loc, "v", { label: "any" }),
    );
    assert.equal(error, undefined);
    assert.equal(
      stdio.filter((l) => l.includes("selector fallback")).length,
      0,
    );
    assert.ok(
      entries.some(
        (e) => e.level === "debug" && /any: filled in \d+ms/.test(e.message),
      ),
      `expected debug timing entry, got:\n  ${entries.map((e) => `${e.level}: ${e.message}`).join("\n  ")}`,
    );
  });

  it("logs a fallback-triggered warning when the fill is slow", async () => {
    const loc = fakeLocator({
      fill: async () => {
        await new Promise((r) => setTimeout(r, 60));
      },
    });
    const { stdio, error } = await runWithLogCapture("t5", () =>
      safeFill(loc, "v", { label: "slow-field", _slowThresholdMs: 50 }),
    );
    assert.equal(error, undefined);
    assert.ok(
      stdio.some((l) =>
        /selector fallback triggered: slow-field \(fill took \d+ms — likely fallback-hit or page stall\)/.test(
          l,
        ),
      ),
      `expected slow-success fallback warning, got:\n  ${stdio.join("\n  ")}`,
    );
  });

  it("logs a unified 'selector fallback triggered' error with timing and re-throws on failure", async () => {
    const fillErr = new Error("TimeoutError: locator.fill timed out");
    const loc = fakeLocator({
      fill: async () => {
        throw fillErr;
      },
    });
    const { stdio, entries, error } = await runWithLogCapture("t6", () =>
      safeFill(loc, "x", { label: "national-id" }),
    );
    assert.equal(error, fillErr);
    assert.ok(
      stdio.some((l) =>
        /selector fallback triggered: national-id \(fill failed after \d+ms — TimeoutError: locator\.fill timed out\)/.test(
          l,
        ),
      ),
      `expected unified error line with timing + message, got:\n  ${stdio.join("\n  ")}`,
    );
    assert.ok(
      entries.some(
        (e) =>
          e.level === "error" &&
          /selector fallback triggered: national-id \(fill failed after \d+ms/.test(
            e.message,
          ),
      ),
      "expected matching error entry in JSONL (shares the 'selector fallback triggered' marker)",
    );
  });
});
