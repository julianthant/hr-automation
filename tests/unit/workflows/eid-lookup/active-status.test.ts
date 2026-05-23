import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveActiveStatusResultsForEidLookup } from "../../../../src/workflows/eid-lookup/workflow.js";
import type { EidResult } from "../../../../src/systems/ucpath/person-org-summary.js";

test("resolveActiveStatusResultsForEidLookup narrows multi-result name search by CRM matched EID", () => {
  const results = [
    {
      emplId: "10700001",
      name: "Person, One",
      lastName: "Person",
      department: "Other",
      hrStatus: "Active",
    },
    {
      emplId: "10700002",
      name: "Person, Two",
      lastName: "Person",
      department: "SDCMP HDH",
      hrStatus: "Active",
    },
  ] as EidResult[];

  const resolved = resolveActiveStatusResultsForEidLookup({
    input: { name: "Person, Test" },
    sdcmpFromSearch: results,
    crmMatchedEmplId: "10700002",
  });

  assert.deepEqual(resolved.deriveInput, { kind: "by-eid", emplId: "10700002" });
  assert.equal(resolved.results.length, 1);
  assert.equal(resolved.results[0]?.emplId, "10700002");
});
