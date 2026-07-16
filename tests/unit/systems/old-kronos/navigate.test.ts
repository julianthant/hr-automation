import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { parseOldKronosVisibleDateTexts } from "../../../../src/systems/old-kronos/navigate.js";

describe("parseOldKronosVisibleDateTexts", () => {
  it("accepts actual timecard date cells and returns their visible bounds", () => {
    assert.deepEqual(
      parseOldKronosVisibleDateTexts(["Sun 7/05", "Mon 7/06", "Sat 7/18"]),
      { first: { month: 7, day: 5 }, last: { month: 7, day: 18 } },
    );
  });

  it("rejects the Genies frame even though it also has #timeframe-selector-input", () => {
    assert.equal(
      parseOldKronosVisibleDateTexts([
        "HDH/-/-/H-2/HDH-FBS-BCS-12510/0/40842318",
        "SX-8Hol-8-CT-30",
      ]),
      null,
    );
  });
});
