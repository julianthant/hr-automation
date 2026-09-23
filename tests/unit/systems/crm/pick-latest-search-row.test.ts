import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { pickLatestOnboardingSearchRowIndex } from "../../../../src/systems/crm/pick-latest-search-row.js";

describe("pickLatestOnboardingSearchRowIndex", () => {
  test("skips the header-only Search Results row and picks the dated record", () => {
    const index = pickLatestOnboardingSearchRowIndex([
      { hasNameLink: false, offerSentOn: "", processStage: "" },
      {
        hasNameLink: true,
        offerSentOn: "September 10, 2026",
        processStage: "Campus Forms Pending Approval",
      },
    ]);
    assert.equal(index, 1);
  });

  test("skips Offer Rescinded even when it has the latest date", () => {
    const index = pickLatestOnboardingSearchRowIndex([
      { hasNameLink: false, offerSentOn: "", processStage: "" },
      {
        hasNameLink: true,
        offerSentOn: "September 14, 2026",
        processStage: "Offer Rescinded",
      },
      {
        hasNameLink: true,
        offerSentOn: "September 10, 2026",
        processStage: "Campus Forms Pending Approval",
      },
    ]);
    assert.equal(index, 2);
  });

  test("throws when every linked record is rescinded", () => {
    assert.throws(
      () =>
        pickLatestOnboardingSearchRowIndex([
          { hasNameLink: true, offerSentOn: "September 14, 2026", processStage: "Offer Rescinded" },
        ]),
      /dead stage/i,
    );
  });

  test("throws when only a header row is present", () => {
    assert.throws(
      () => pickLatestOnboardingSearchRowIndex([{ hasNameLink: false, offerSentOn: "", processStage: "" }]),
      /no record links/i,
    );
  });
});
