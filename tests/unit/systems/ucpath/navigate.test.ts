import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  classifyPersonSearchSignal,
  personSearchCriteriaSufficient,
} from "../../../../src/systems/ucpath/navigate.js";

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

/**
 * UCPath person search needs an SSN or a DOB (its search orders are "NID Only" /
 * "Legal Name + Bday + NID" / "Legal First Name + DOB"). A record with neither
 * leaves the Search button disabled, so we must fail fast rather than click it.
 */
describe("personSearchCriteriaSufficient", () => {
  it("SSN present, no DOB → searchable", () => {
    assert.equal(personSearchCriteriaSufficient("123456789", ""), true);
  });

  it("DOB present, no SSN → searchable (international student, no SSN)", () => {
    assert.equal(personSearchCriteriaSufficient("", "01/15/2000"), true);
  });

  it("both present → searchable", () => {
    assert.equal(personSearchCriteriaSufficient("123456789", "01/15/2000"), true);
  });

  it("neither present → NOT searchable (the juzaw case → fail loud)", () => {
    assert.equal(personSearchCriteriaSufficient("", ""), false);
  });

  it("whitespace-only values count as absent", () => {
    assert.equal(personSearchCriteriaSufficient("   ", "  "), false);
  });
});
