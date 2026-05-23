import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";

// ANNUAL_DATES is read at module-load time, so each assertion needs a fresh
// import after mutating process.env. Under vitest we use `vi.resetModules()`
// to invalidate the ESM cache; under the old node:test runner this was done
// with `?case=...` query suffixes, which Vite's TS transformer rejects
// because it can't see the path as a .ts source once a query is appended.

let originalJobEnd: string | undefined;
let originalKronosEnd: string | undefined;
let originalKronosStart: string | undefined;

describe("ANNUAL_DATES", () => {
  beforeEach(() => {
    originalJobEnd = process.env.ANNUAL_DATES_END;
    originalKronosEnd = process.env.KRONOS_DEFAULT_END_DATE;
    originalKronosStart = process.env.KRONOS_DEFAULT_START_DATE;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalJobEnd !== undefined) {
      process.env.ANNUAL_DATES_END = originalJobEnd;
    } else {
      delete process.env.ANNUAL_DATES_END;
    }
    if (originalKronosEnd !== undefined) {
      process.env.KRONOS_DEFAULT_END_DATE = originalKronosEnd;
    } else {
      delete process.env.KRONOS_DEFAULT_END_DATE;
    }
    if (originalKronosStart !== undefined) {
      process.env.KRONOS_DEFAULT_START_DATE = originalKronosStart;
    } else {
      delete process.env.KRONOS_DEFAULT_START_DATE;
    }
  });

  it("uses hardcoded defaults when no env vars are set", async () => {
    delete process.env.ANNUAL_DATES_END;
    delete process.env.KRONOS_DEFAULT_END_DATE;
    delete process.env.KRONOS_DEFAULT_START_DATE;

    const mod = await import("../../src/config.js");
    assert.equal(mod.ANNUAL_DATES.jobEndDate, "06/30/2026");
    assert.equal(mod.ANNUAL_DATES.kronosDefaultEndDate, "2/1/2026");
    assert.equal(mod.ANNUAL_DATES.kronosDefaultStartDate, "1/1/2017");
  });

  it("ANNUAL_DATES_END overrides jobEndDate", async () => {
    process.env.ANNUAL_DATES_END = "06/30/2027";
    const mod = await import("../../src/config.js");
    assert.equal(mod.ANNUAL_DATES.jobEndDate, "06/30/2027");
  });

  it("KRONOS_DEFAULT_END_DATE overrides kronosDefaultEndDate", async () => {
    process.env.KRONOS_DEFAULT_END_DATE = "3/15/2027";
    const mod = await import("../../src/config.js");
    assert.equal(mod.ANNUAL_DATES.kronosDefaultEndDate, "3/15/2027");
  });

  it("KRONOS_DEFAULT_START_DATE overrides kronosDefaultStartDate", async () => {
    process.env.KRONOS_DEFAULT_START_DATE = "1/1/2020";
    const mod = await import("../../src/config.js");
    assert.equal(mod.ANNUAL_DATES.kronosDefaultStartDate, "1/1/2020");
  });

  it("all three env vars can override simultaneously", async () => {
    process.env.ANNUAL_DATES_END = "06/30/2028";
    process.env.KRONOS_DEFAULT_END_DATE = "4/1/2028";
    process.env.KRONOS_DEFAULT_START_DATE = "1/1/2022";
    const mod = await import("../../src/config.js");
    assert.equal(mod.ANNUAL_DATES.jobEndDate, "06/30/2028");
    assert.equal(mod.ANNUAL_DATES.kronosDefaultEndDate, "4/1/2028");
    assert.equal(mod.ANNUAL_DATES.kronosDefaultStartDate, "1/1/2022");
  });
});
