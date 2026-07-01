import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { classifyPersonSearchSignal } from "../../../../src/systems/ucpath/navigate.js";

/**
 * The new-hire-vs-rehire decision. Misclassifying a real rehire as a new hire
 * makes onboarding CREATE a duplicate person, so the classifier races the two
 * definitive UI outcomes and only decides once one is actually present:
 * - results grid → rehire (found)
 * - confirmation dialog → new hire (not found)
 * - neither (race timeout) → ambiguous → caller must fall back, never guess.
 */
describe("classifyPersonSearchSignal", () => {
  it("results-grid → rehire (found, not ambiguous)", () => {
    assert.deepEqual(classifyPersonSearchSignal("results-grid"), {
      found: true,
      ambiguous: false,
    });
  });

  it("duplicate-dialog → new hire (not found, not ambiguous)", () => {
    assert.deepEqual(classifyPersonSearchSignal("duplicate-dialog"), {
      found: false,
      ambiguous: false,
    });
  });

  it("none → not found + AMBIGUOUS (caller must use the legacy fallback probe)", () => {
    assert.deepEqual(classifyPersonSearchSignal("none"), {
      found: false,
      ambiguous: true,
    });
  });
});
