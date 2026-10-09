import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveActiveStatusResultsForPersonLookup } from "../../../../src/workflows/person-lookup/workflow.js";
import type { EidResult } from "../../../../src/systems/ucpath/person-org-summary.js";

test("resolveActiveStatusResultsForPersonLookup narrows multi-result name search by CRM matched EID", () => {
  const results = [
    {
      emplId: "10090173",
      name: "Person, One",
      lastName: "Person",
      department: "Other",
      hrStatus: "Active",
    },
    {
      emplId: "10090174",
      name: "Person, Two",
      lastName: "Person",
      department: "SDCMP HDH",
      hrStatus: "Active",
    },
  ] as EidResult[];

  const resolved = resolveActiveStatusResultsForPersonLookup({
    input: { name: "Person, Test" },
    sdcmpFromSearch: results,
    crmMatchedEmplId: "10090174",
  });

  assert.deepEqual(resolved.deriveInput, { kind: "by-eid", emplId: "10090174" });
  assert.equal(resolved.results.length, 1);
  assert.equal(resolved.results[0]?.emplId, "10090174");
});
