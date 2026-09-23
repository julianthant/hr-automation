import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { decideUcpathTransactionSmartHrNav } from "../../../../src/workflows/separations/steps/ucpath-transaction.js";

describe("decideUcpathTransactionSmartHrNav", () => {
  it("skips only when already on non-SS Smart HR and no SS lookup ran", () => {
    assert.equal(
      decideUcpathTransactionSmartHrNav({
        alreadyAtSmartHR: true,
        ranSsSmartHrLookup: false,
      }),
      "skip",
    );
  });

  it("navigates after an SS Smart HR lookup even if alreadyAtSmartHR was true", () => {
    // Live 2026-09-18: findExistingTermination* left alreadyAtSmartHR=true,
    // then findTerminationTransactionStatus moved onto SS Smart HR. Trusting
    // the flag skipped re-nav and selectTemplate timed out on the SS form.
    assert.equal(
      decideUcpathTransactionSmartHrNav({
        alreadyAtSmartHR: true,
        ranSsSmartHrLookup: true,
      }),
      "navigate",
    );
  });

  it("navigates when not already at Smart HR", () => {
    assert.equal(
      decideUcpathTransactionSmartHrNav({
        alreadyAtSmartHR: false,
        ranSsSmartHrLookup: false,
      }),
      "navigate",
    );
  });
});
