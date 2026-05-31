import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { DASHBOARD_INPUT_RUN_WORKFLOWS, DASHBOARD_UPLOAD_RUN_WORKFLOWS } from "../../../../src/domain/dashboard-run-surfaces.js";
import { WORKFLOW_LOADERS, listWorkflowNames } from "../../../../src/core/workflow-loaders.js";
import {
  deriveActiveCheckOutcome,
  derivePersonLookupSelection,
  type PersonLookupResult,
} from "../../../../src/workflows/person-lookup/index.js";

function personRow(patch: Partial<PersonLookupResult> = {}): PersonLookupResult {
  return {
    emplId: "10733938",
    name: "Martha Agook",
    hrStatus: "Active",
    department: "HOUSING/DINING/HOSPITALITY",
    effectiveDate: "04/13/2026",
    terminationDate: "",
    expectedJobEndDate: "",
    ...patch,
  };
}

describe("person-lookup workflow helper", () => {
  it("is daemon-spawnable and dashboard-startable as an input run", () => {
    assert.equal("person-lookup" in WORKFLOW_LOADERS, true);
    assert.equal(listWorkflowNames().includes("person-lookup"), true);
    assert.equal((DASHBOARD_INPUT_RUN_WORKFLOWS as readonly string[]).includes("person-lookup"), true);
    assert.equal((DASHBOARD_UPLOAD_RUN_WORKFLOWS as readonly string[]).includes("person-lookup"), false);
  });

  it("selects the active row when Person Org returns active and inactive rows for the same EID", () => {
    const selection = derivePersonLookupSelection({ kind: "by-name", name: "Agook, Martha" }, [
      personRow({
        hrStatus: "Inactive",
        department: "TEMPORARY EMPLOYMENT SERVICES",
        terminationDate: "04/12/2026",
      }),
      personRow(),
    ]);

    assert.equal(selection.status, "resolved");
    assert.equal(selection.selected?.hrStatus, "Active");
    assert.deepEqual(selection.candidateEids, ["10733938"]);
  });

  it("active-check derives from the shared person lookup selection", () => {
    const outcome = deriveActiveCheckOutcome({ kind: "by-name", name: "Agook, Martha" }, [
      personRow({
        hrStatus: "Inactive",
        department: "TEMPORARY EMPLOYMENT SERVICES",
        terminationDate: "04/12/2026",
      }),
      personRow(),
    ]);

    assert.equal(outcome.activeStatus, "active");
    assert.equal(outcome.emplId, "10733938");
    assert.equal(outcome.department, "HOUSING/DINING/HOSPITALITY");
  });
});
