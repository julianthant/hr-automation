import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldDemoteExistingContactForRun } from "../../../../src/workflows/emergency-contact/workflow.js";

describe("shouldDemoteExistingContactForRun", () => {
  it("does not demote fuzzy duplicates during dry run", () => {
    assert.equal(
      shouldDemoteExistingContactForRun({ name: "Jon Doe", distance: 1, isExact: false }, true),
      false,
    );
  });

  it("demotes fuzzy duplicates during real runs", () => {
    assert.equal(
      shouldDemoteExistingContactForRun({ name: "Jon Doe", distance: 1, isExact: false }, false),
      true,
    );
  });

  it("does not demote exact matches or missing matches", () => {
    assert.equal(
      shouldDemoteExistingContactForRun({ name: "John Doe", distance: 0, isExact: true }, false),
      false,
    );
    assert.equal(shouldDemoteExistingContactForRun(null, false), false);
  });
});
