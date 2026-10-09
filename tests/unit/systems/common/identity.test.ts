/**
 * Pins the shared pre-submit identity gate primitive
 * (`src/systems/common/identity.ts`): the pure compare
 * (`checkDisplayedIdentity`) and the async fail-loud gate
 * (`assertDisplayedIdentity`). This is the extracted core that New Kronos /
 * OnBase / Emergency Contact / Oath Signature all delegate their "is the RIGHT
 * person displayed before I Save/Import?" check to.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  checkDisplayedIdentity,
  assertDisplayedIdentity,
} from "../../../../src/systems/common/identity.js";

describe("checkDisplayedIdentity (word-boundary)", () => {
  it("matches when the expected id appears among other header text", () => {
    const r = checkDisplayedIdentity("10090114", "Kosogotaz, Mepaicz L 10090114");
    assert.equal(r.ok, true);
    assert.equal(r.shown, null);
  });

  it("reports a competing 8-digit id when the expected id is absent", () => {
    const r = checkDisplayedIdentity("10090279", "10090268 · Someone Else");
    assert.equal(r.ok, false);
    assert.equal(r.shown, "10090268");
  });

  it("returns null shown when no competing id is visible", () => {
    const r = checkDisplayedIdentity("10090279", "Loading…");
    assert.equal(r.ok, false);
    assert.equal(r.shown, null);
  });

  it("does not partial-match a longer number (word boundary)", () => {
    // "106043760" must NOT satisfy expected "10090114".
    const r = checkDisplayedIdentity("10090114", "Employee 106043760");
    assert.equal(r.ok, false);
  });

  it("tolerates null / undefined displayed text", () => {
    assert.equal(checkDisplayedIdentity("10090114", null).ok, false);
    assert.equal(checkDisplayedIdentity("10090114", undefined).ok, false);
  });

  it("honors a custom competing-id pattern", () => {
    const r = checkDisplayedIdentity("ABC", "shown XYZ", {
      competingIdPattern: /[A-Z]{3}/,
    });
    assert.equal(r.ok, false);
    assert.equal(r.shown, "XYZ");
  });

  it("throws on an empty expected identity (never silently passes)", () => {
    assert.throws(() => checkDisplayedIdentity("", "anything"), /expected identity is empty/);
    assert.throws(() => checkDisplayedIdentity("   ", "anything"), /expected identity is empty/);
  });
});

describe("checkDisplayedIdentity (exact)", () => {
  it("matches only an exact, trimmed field value", () => {
    assert.equal(checkDisplayedIdentity("10090312", " 10090312 ", { mode: "exact" }).ok, true);
    assert.equal(checkDisplayedIdentity("10090312", "10090312", { mode: "exact" }).ok, true);
  });

  it("fails a different value and reports the whole displayed value", () => {
    const r = checkDisplayedIdentity("10090312", "10090311", { mode: "exact" });
    assert.equal(r.ok, false);
    assert.equal(r.shown, "10090311");
  });

  it("fails a value that merely CONTAINS the expected (exact ≠ substring)", () => {
    const r = checkDisplayedIdentity("10090312", "10090312 Person 905", { mode: "exact" });
    assert.equal(r.ok, false);
    assert.equal(r.shown, "10090312 Person 905");
  });

  it("reports null shown for an empty field value", () => {
    const r = checkDisplayedIdentity("10090312", "", { mode: "exact" });
    assert.equal(r.ok, false);
    assert.equal(r.shown, null);
  });
});

const noSleep = async (): Promise<void> => {};

describe("assertDisplayedIdentity", () => {
  it("resolves silently when the displayed identity matches", async () => {
    await assertDisplayedIdentity({
      expected: "10090114",
      context: "test",
      extract: async () => "Kosogotaz, Mepaicz L 10090114",
    });
  });

  it("throws naming expected vs the competing displayed id", async () => {
    await assert.rejects(
      assertDisplayedIdentity({
        expected: "10090279",
        context: "New Kronos timecard",
        extract: async () => "10090268 · Someone Else",
      }),
      (err: Error) =>
        /New Kronos timecard/.test(err.message) &&
        /10090279/.test(err.message) &&
        /10090268/.test(err.message),
    );
  });

  it("throws (fails loud) when the expected id is simply absent", async () => {
    await assert.rejects(
      assertDisplayedIdentity({
        expected: "10090279",
        context: "ctx",
        extract: async () => "Loading…",
      }),
      /was not found on the page/,
    );
  });

  it("treats an extract throw as inconclusive and fails loud (never passes)", async () => {
    await assert.rejects(
      assertDisplayedIdentity({
        expected: "10090279",
        context: "OnBase import",
        extract: async () => {
          throw new Error("frame detached");
        },
      }),
      (err: Error) =>
        /could not read the displayed identity/.test(err.message) &&
        /frame detached/.test(err.message),
    );
  });

  it("polls until the identity switches in, then resolves", async () => {
    let calls = 0;
    let clock = 0;
    await assertDisplayedIdentity({
      expected: "10090114",
      context: "ctx",
      pollMs: 5_000,
      pollIntervalMs: 500,
      _sleep: async () => {
        clock += 500;
      },
      _now: () => clock,
      extract: async () => {
        calls += 1;
        // Previous employee for the first two reads, then the switch lands.
        return calls < 3 ? "OldPerson 10999999" : "NewPerson 10090114";
      },
    });
    assert.equal(calls, 3);
  });

  it("throws after the poll deadline when the identity never matches", async () => {
    let clock = 0;
    await assert.rejects(
      assertDisplayedIdentity({
        expected: "10090114",
        context: "ctx",
        pollMs: 2_000,
        pollIntervalMs: 500,
        _sleep: async () => {
          clock += 500;
        },
        _now: () => clock,
        extract: async () => "Stuck 10999999",
      }),
      (err: Error) => /10090114/.test(err.message) && /10999999/.test(err.message),
    );
  });

  it("does a single read when pollMs is unset", async () => {
    let calls = 0;
    await assert.rejects(
      assertDisplayedIdentity({
        expected: "10090114",
        context: "ctx",
        _sleep: noSleep,
        extract: async () => {
          calls += 1;
          return "Nope 10090015";
        },
      }),
      /does not match/,
    );
    assert.equal(calls, 1);
  });
});
