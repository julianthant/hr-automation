import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  isIncompleteI9SectionAction,
  isSelectableI9SignerLookupAction,
  pickI9SignerSearchResult,
} from "../../../../src/systems/i9/search.js";
import type { I9SearchResult } from "../../../../src/systems/i9/types.js";

function result(patch: Partial<I9SearchResult>): I9SearchResult {
  return {
    rowIndex: 0,
    lastName: "Provenzano",
    firstName: "Vincent",
    employer: "UC San Diego",
    worksite: "6-000412 HOUSING/DINING/...",
    profileId: "1670462",
    i9Id: "1602018",
    nextAction: "Purge",
    startDate: "11/3/2021",
    createdOn: "10/26/2021",
    navUrl: "/employee/navToNextAction/1670462?i9Id=1602018",
    ...patch,
  };
}

describe("I9 signer lookup search-result selection", () => {
  it("treats Complete Section 1 and Complete Section 2 as incomplete rows", () => {
    assert.equal(isIncompleteI9SectionAction("Complete Section 1"), true);
    assert.equal(isIncompleteI9SectionAction("Complete Section\n2"), true);
  });

  it("treats Purge and Rehire rows as selectable signer lookup rows", () => {
    assert.equal(isSelectableI9SignerLookupAction("Purge"), true);
    assert.equal(isSelectableI9SignerLookupAction("Rehire"), true);
  });

  it("selects the Purge row when Complete Section rows appear first", () => {
    const selected = pickI9SignerSearchResult([
      result({ rowIndex: 0, i9Id: "1610788", nextAction: "Complete Section 2" }),
      result({ rowIndex: 1, i9Id: "1602018", nextAction: "Purge" }),
    ]);

    assert.equal(selected?.rowIndex, 1);
  });

  it("returns undefined when only Complete Section rows are present", () => {
    const selected = pickI9SignerSearchResult([
      result({ nextAction: "Complete Section 1" }),
      result({ nextAction: "Complete Section 2" }),
    ]);

    assert.equal(selected, undefined);
  });
});
