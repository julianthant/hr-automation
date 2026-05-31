import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { hrTasks } from "../../../../src/systems/ucpath/selectors.js";

describe("UCPath hrTasks selectors", () => {
  it("targets the exact Smart HR Transactions leaf, not SS Smart HR Transactions", () => {
    const calls: Array<{ role: string; options: unknown }> = [];
    const sentinel = {} as Locator;
    const page = {
      getByRole(role: string, options: unknown): Locator {
        calls.push({ role, options });
        return sentinel;
      },
      getByText(): Locator {
        throw new Error("smartHRTransactionsLink must not use loose text matching");
      },
    } as unknown as Page;

    const locator = hrTasks.smartHRTransactionsLink(page);

    assert.equal(locator, sentinel);
    assert.deepEqual(calls, [
      {
        role: "link",
        options: { name: "Smart HR Transactions", exact: true },
      },
    ]);
  });
});
