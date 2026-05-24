import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import type { Locator } from "playwright";
import { log } from "../../../../src/utils/log.js";
import { safeClick, safeFill } from "../../../../src/systems/common/index.js";

function fakeClickLocator(opts: { rejectWith?: Error } = {}): Locator {
  return {
    click: async (_params?: unknown) => {
      if (opts.rejectWith) throw opts.rejectWith;
    },
    fill: async (_value: string, _params?: unknown) => {},
  } as unknown as Locator;
}

function fakeFillLocator(opts: { rejectWith?: Error } = {}): Locator {
  return {
    click: async (_params?: unknown) => {},
    fill: async (_value: string, _params?: unknown) => {
      if (opts.rejectWith) throw opts.rejectWith;
    },
  } as unknown as Locator;
}

// Dashboard-visible invariant check: message must start with
// "selector fallback triggered: <label> (" — exactly as SELECTOR_FALLBACK_RE expects.
function assertFallbackInvariant(msg: string, label: string): void {
  assert.match(
    msg,
    new RegExp(`^selector fallback triggered: ${label} \\(`),
    `Message must start with 'selector fallback triggered: ${label} (' — dashboard regex depends on this shape`,
  );
}

describe("safeClick fallback attempt logging", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(log, "debug").mockImplementation(() => {});
    warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("quick success logs at debug with label and elapsed", async () => {
    const locator = fakeClickLocator();
    await safeClick(locator, { label: "myLabel" });

    assert.equal(debugSpy.mock.calls.length, 1);
    const msg = debugSpy.mock.calls[0]![0] as string;
    assert.match(msg, /myLabel: clicked in/);
    assert.match(msg, /ms$/);

    assert.equal(warnSpy.mock.calls.length, 0);
    assert.equal(errorSpy.mock.calls.length, 0);
  });

  it("slow success logs at warn with fallback marker", async () => {
    // _slowThresholdMs: -1 ensures elapsed > threshold even when both
    // Date.now() calls land in the same millisecond tick (elapsed = 0 > -1).
    const locator = fakeClickLocator();
    await safeClick(locator, { label: "myLabel", _slowThresholdMs: -1 });

    assert.equal(warnSpy.mock.calls.length, 1);
    const msg = warnSpy.mock.calls[0]![0] as string;

    // Invariant 1 + 2: literal prefix + "(" delimiter
    assertFallbackInvariant(msg, "myLabel");
    // Invariant 3: correct level (warn, not error)
    assert.match(msg, /click took \d+ms — likely fallback-hit or page stall\)$/);

    assert.equal(debugSpy.mock.calls.length, 0);
    assert.equal(errorSpy.mock.calls.length, 0);
  });

  it("failure logs at error with marker and re-throws", async () => {
    const cause = new Error("Timeout 30000ms exceeded");
    const locator = fakeClickLocator({ rejectWith: cause });

    await assert.rejects(
      () => safeClick(locator, { label: "myLabel" }),
      (err: unknown) => err === cause,
    );

    assert.equal(errorSpy.mock.calls.length, 1);
    const msg = errorSpy.mock.calls[0]![0] as string;

    // Invariant 1 + 2
    assertFallbackInvariant(msg, "myLabel");
    // Invariant 3: level is error (caller verifies via spy name)
    assert.match(msg, /click failed after \d+ms — Timeout 30000ms exceeded\)$/);

    assert.equal(debugSpy.mock.calls.length, 0);
    assert.equal(warnSpy.mock.calls.length, 0);
  });
});

describe("safeFill fallback attempt logging", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(log, "debug").mockImplementation(() => {});
    warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("quick success logs at debug with label and elapsed", async () => {
    const locator = fakeFillLocator();
    await safeFill(locator, "hello", { label: "myLabel" });

    assert.equal(debugSpy.mock.calls.length, 1);
    const msg = debugSpy.mock.calls[0]![0] as string;
    assert.match(msg, /myLabel: filled in/);
    assert.match(msg, /ms$/);

    assert.equal(warnSpy.mock.calls.length, 0);
    assert.equal(errorSpy.mock.calls.length, 0);
  });

  it("slow success logs at warn with fallback marker", async () => {
    // _slowThresholdMs: -1 ensures elapsed > threshold even when both
    // Date.now() calls land in the same millisecond tick (elapsed = 0 > -1).
    const locator = fakeFillLocator();
    await safeFill(locator, "hello", { label: "myLabel", _slowThresholdMs: -1 });

    assert.equal(warnSpy.mock.calls.length, 1);
    const msg = warnSpy.mock.calls[0]![0] as string;

    assertFallbackInvariant(msg, "myLabel");
    assert.match(msg, /fill took \d+ms — likely fallback-hit or page stall\)$/);

    assert.equal(debugSpy.mock.calls.length, 0);
    assert.equal(errorSpy.mock.calls.length, 0);
  });

  it("failure logs at error with marker and re-throws", async () => {
    const cause = new Error("Timeout 30000ms exceeded");
    const locator = fakeFillLocator({ rejectWith: cause });

    await assert.rejects(
      () => safeFill(locator, "hello", { label: "myLabel" }),
      (err: unknown) => err === cause,
    );

    assert.equal(errorSpy.mock.calls.length, 1);
    const msg = errorSpy.mock.calls[0]![0] as string;

    assertFallbackInvariant(msg, "myLabel");
    assert.match(msg, /fill failed after \d+ms — Timeout 30000ms exceeded\)$/);

    assert.equal(debugSpy.mock.calls.length, 0);
    assert.equal(warnSpy.mock.calls.length, 0);
  });
});
