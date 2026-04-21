import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { closeAllKendoWindows } from "../../../../src/systems/i9/navigate.js";

describe("closeAllKendoWindows", () => {
  it("calls page.evaluate then page.keyboard.press('Escape') then waits", async () => {
    const calls: string[] = [];
    const fakePage = {
      evaluate: async () => { calls.push("evaluate"); },
      keyboard: { press: async (key: string) => { calls.push(`press:${key}`); } },
      waitForTimeout: async (ms: number) => { calls.push(`wait:${ms}`); },
    };
    await closeAllKendoWindows(fakePage as never);
    assert.deepStrictEqual(calls, ["evaluate", "press:Escape", "wait:250"]);
  });

  it("swallows evaluate errors (page may have no k-windows)", async () => {
    const fakePage = {
      evaluate: async () => { throw new Error("no elements"); },
      keyboard: { press: async () => {} },
      waitForTimeout: async () => {},
    };
    await closeAllKendoWindows(fakePage as never);
  });

  it("swallows keyboard errors", async () => {
    const fakePage = {
      evaluate: async () => {},
      keyboard: { press: async () => { throw new Error("boom"); } },
      waitForTimeout: async () => {},
    };
    await closeAllKendoWindows(fakePage as never);
  });
});
