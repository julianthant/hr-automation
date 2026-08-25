import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { FrameLocator, Locator, Page } from "playwright";

import { hrTasks, jobSummary, termination } from "../../../../src/systems/ucpath/selectors.js";

/** Captures the raw CSS a selector hands to `frame.locator(...)`. */
function captureFrameSelector(build: (f: FrameLocator) => Locator): string {
  const seen: string[] = [];
  const frame = {
    locator(selector: string): Locator {
      seen.push(selector);
      return {} as Locator;
    },
  } as unknown as FrameLocator;

  build(frame);
  assert.equal(seen.length, 1, "expected exactly one frame.locator() call");
  return seen[0]!;
}

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

/**
 * Live regression (2026-07-28, editable UC_VOL_TERM form): PeopleSoft renders
 * each checkbox as the visible input PLUS a hidden `<FIELD>$chk$<row>`
 * companion carrying the posted Y/N value. A bare `id^="…CHK2$"` prefix matched
 * BOTH `HR_TBH_SCR_WRK_TBH_CHK2$3` and `HR_TBH_SCR_WRK_TBH_CHK2$chk$3`, so
 * every `isChecked()` threw a strict-mode violation and no separation could
 * write its Last Date Worked. The element-type constraint is what keeps these
 * at one match — dropping it re-breaks the write.
 */
describe("UCPath termination selectors", () => {
  it("constrains the override to a real checkbox, not PeopleSoft's hidden $chk$ companion", () => {
    const selector = captureFrameSelector(termination.overrideLastDateWorkedCheckbox);

    assert.match(selector, /^input\[type="checkbox"\]/);
    // Prefix-matched so the PeopleSoft row suffix ($3 today) stays free.
    assert.match(selector, /\[id\^="HR_TBH_SCR_WRK_TBH_CHK2\$"\]/);
  });

  it("constrains Last Date Worked to the input, not its calendar anchor/icon", () => {
    // `HR_TBH_SCR_WRK_TBH_DATE$prompt$3` (<a>) and `…$prompt$img$3` (<img>)
    // share the prefix; `input` is what keeps this a single match, and it also
    // makes a read-only transaction fail closed rather than look editable.
    const selector = captureFrameSelector(termination.lastDateWorkedInput);

    assert.match(selector, /^input\[/);
    assert.match(selector, /\[id\^="HR_TBH_SCR_WRK_TBH_DATE\$"\]/);
  });
});

class CountingLocator {
  constructor(private readonly matches: number) {}

  getByRole(): CountingLocator {
    return new CountingLocator(1);
  }

  locator(selector: string): CountingLocator {
    return new CountingLocator(selector.includes("EMPLID") ? 0 : this.matches);
  }

  or(other: CountingLocator): CountingLocator {
    return new CountingLocator(this.matches + other.matches);
  }

  first(): CountingLocator {
    return new CountingLocator(Math.min(this.matches, 1));
  }

  async count(): Promise<number> {
    return this.matches;
  }
}

describe("jobSummary.rowDrillInLink", () => {
  it("resolves one click target when a Fluid result row also contains a drill-in link", async () => {
    const fluidRowWithNestedLink = new CountingLocator(1) as unknown as Locator;
    const target = jobSummary.rowDrillInLink(fluidRowWithNestedLink);

    assert.equal(
      await target.count(),
      1,
      "strict-mode click must not receive both the result <tr> and its nested drill-in <a>",
    );
  });
});
