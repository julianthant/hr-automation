import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeOcrVerification,
  patchOcrRecordFromEidLookupOutcome,
  patchOcrRecordUnresolved,
} from "../../../../src/workflows/ocr/eid-lookup-results.js";

test("patchOcrRecordFromEidLookupOutcome resolves a name lookup with EID and verification", () => {
  const records: unknown[] = [{
    printedName: "Liam Kustenbauder",
    matchState: "lookup-pending",
    selected: true,
    warnings: [],
  }];

  patchOcrRecordFromEidLookupOutcome(records, 0, {
    workflow: "eid-lookup",
    itemId: "lookup-1",
    runId: "child-1",
    status: "done",
    data: {
      emplId: "10000001",
      hrStatus: "Active",
      department: "Housing Dining Hospitality",
      personOrgScreenshot: "person.png",
    },
  }, "name");

  const rec = records[0] as Record<string, unknown>;
  assert.equal(rec.employeeId, "10000001");
  assert.equal(rec.matchState, "resolved");
  assert.equal(rec.matchSource, "eid-lookup");
  assert.deepEqual((rec.verification as { state: string }).state, "verified");
  assert.equal(rec.selected, true);
});

test("patchOcrRecordFromEidLookupOutcome deselects inactive and non-HDH records", () => {
  const records: unknown[] = [{ employeeId: "10000001", selected: true }];

  patchOcrRecordFromEidLookupOutcome(records, 0, {
    workflow: "eid-lookup",
    itemId: "lookup-1",
    runId: "child-1",
    status: "done",
    data: {
      emplId: "10000001",
      hrStatus: "Inactive",
      department: "HDH",
    },
  }, "verify");

  assert.equal((records[0] as { selected?: boolean }).selected, false);
});

test("patchOcrRecordUnresolved marks lookup-pending record unresolved", () => {
  const records: unknown[] = [{ matchState: "lookup-pending", warnings: [] }];
  patchOcrRecordUnresolved(records, 0, "eid-lookup did not return within timeout");
  const rec = records[0] as { matchState?: string; warnings?: string[] };
  assert.equal(rec.matchState, "unresolved");
  assert.deepEqual(rec.warnings, ["eid-lookup did not return within timeout"]);
});

test("computeOcrVerification classifies Active HDH as verified", () => {
  assert.equal(
    computeOcrVerification({ hrStatus: "Active", department: "Housing Dining Hospitality", personOrgScreenshot: "x.png" }).state,
    "verified",
  );
});
