import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildEmergencyContactPendingData,
  shouldDemoteExistingContactForRun,
} from "../../../../src/workflows/emergency-contact/workflow.js";

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

describe("buildEmergencyContactPendingData", () => {
  it("preserves the pending row shape used by in-process and daemon adapters", () => {
    assert.deepEqual(
      buildEmergencyContactPendingData(
        {
          sourcePage: 3,
          dryRun: true,
          employee: {
            name: "Jane Doe",
            employeeId: "10873698",
          },
          emergencyContact: {
            name: "Pat Doe",
            relationship: "Parent",
            primary: true,
            sameAddressAsEmployee: true,
          },
          notes: [],
        },
        "May batch",
      ),
      {
        batchName: "May batch",
        sourcePage: "3",
        emplId: "10873698",
        employeeName: "Jane Doe",
        contactName: "Pat Doe",
        relationship: "Parent",
        dryRun: "true",
      },
    );
  });
});
