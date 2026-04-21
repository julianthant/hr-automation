import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitForSaveEnabled } from "../../../../src/systems/ucpath/transaction.js";

type FakeLocator = {
  isEnabled: () => Promise<boolean>;
  waitFor: () => Promise<void>;
};

describe("waitForSaveEnabled", () => {
  it("resolves immediately when the button is enabled on first poll", async () => {
    const locator: FakeLocator = {
      isEnabled: async () => true,
      waitFor: async () => {},
    };
    await waitForSaveEnabled(locator as never, { timeoutMs: 1000, pollMs: 50 });
  });

  it("throws with diagnostic message when still disabled after timeout", async () => {
    const locator: FakeLocator = {
      isEnabled: async () => false,
      waitFor: async () => {},
    };
    await assert.rejects(
      waitForSaveEnabled(locator as never, { timeoutMs: 150, pollMs: 50 }),
      /Save and Submit remained disabled/,
    );
  });

  it("resolves once the button becomes enabled mid-wait", async () => {
    let calls = 0;
    const locator: FakeLocator = {
      isEnabled: async () => ++calls >= 3,
      waitFor: async () => {},
    };
    await waitForSaveEnabled(locator as never, { timeoutMs: 1000, pollMs: 20 });
    assert.ok(calls >= 3);
  });
});
