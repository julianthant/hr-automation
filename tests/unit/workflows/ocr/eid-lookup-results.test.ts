import { test } from "vitest";
import assert from "node:assert/strict";
import {
  computeOcrVerification,
  patchOcrRecordFromActiveCheckOutcome,
  patchOcrRecordFromEidLookupOutcome,
  patchOcrRecordUnresolved,
} from "../../../../src/services/ocr/eid-lookup-results.js";

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

test("patchOcrRecordFromEidLookupOutcome deselects inactive records", () => {
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

test("patchOcrRecordFromEidLookupOutcome does not let a later not-found candidate overwrite a resolved record", () => {
  const records: unknown[] = [{
    employeeId: "10874100",
    matchState: "resolved",
    matchSource: "eid-lookup",
    selected: true,
    warnings: [],
    verification: {
      state: "non-hdh",
      hrStatus: "Active",
      department: "Bookstore",
      screenshotFilename: "person.png",
      checkedAt: "2026-05-12T21:08:53.669Z",
    },
  }];

  patchOcrRecordFromEidLookupOutcome(records, 0, {
    workflow: "eid-lookup",
    itemId: "lookup-3",
    runId: "child-3",
    status: "done",
    data: {
      emplId: "Not found",
      activeStatus: "not-found",
      hrStatus: "Not found",
    },
  }, "name");

  const rec = records[0] as Record<string, unknown>;
  assert.equal(rec.employeeId, "10874100");
  assert.equal(rec.matchState, "resolved");
  assert.equal((rec.verification as { state: string }).state, "non-hdh");
  assert.equal(rec.selected, true);
});

test("patchOcrRecordFromEidLookupOutcome keeps active non-HDH records selectable", () => {
  const records: unknown[] = [{
    employeeId: "10874100",
    matchState: "lookup-pending",
    selected: false,
    warnings: [],
  }];

  patchOcrRecordFromEidLookupOutcome(records, 0, {
    workflow: "eid-lookup",
    itemId: "lookup-1",
    runId: "child-1",
    status: "done",
    data: {
      emplId: "10874100",
      activeStatus: "non-hdh",
      isActive: "true",
      isHdhAccepted: "false",
      hrStatus: "Active",
      department: "Bookstore",
    },
  }, "verify");

  const rec = records[0] as Record<string, unknown>;
  assert.equal((rec.verification as { state: string }).state, "non-hdh");
  assert.equal(rec.selected, true);
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

test("computeOcrVerification accepts case-insensitive Person Org Active cell + activeStatus summary", () => {
  assert.equal(
    computeOcrVerification({ hrStatus: "active", department: "Housing Dining Hospitality", personOrgScreenshot: "x.png" }).state,
    "verified",
  );
  assert.equal(
    computeOcrVerification({ activeStatus: "ACTIVE", department: "Housing Dining Hospitality", personOrgScreenshot: "y.png" }).state,
    "verified",
  );
});

test("computeOcrVerification reads isActive+isHdhAccepted when present (SQLite projection shape)", () => {
  assert.equal(
    computeOcrVerification({
      isActive: "true",
      isHdhAccepted: "true",
      department: "Housing Dining Hospitality",
      hrStatus: "",
      personOrgScreenshot: "z.png",
    }).state,
    "verified",
  );
});

test("computeOcrVerification detects Active wording not anchored at start of HR cell", () => {
  assert.equal(
    computeOcrVerification({
      hrStatus: "Employed — Active",
      department: "Housing Dining Hospitality",
      personOrgScreenshot: "x.png",
    }).state,
    "verified",
  );
});

test("patchOcrRecordFromEidLookupOutcome uses isActive stamps when hrStatus is sparse", () => {
  const records: unknown[] = [{
    employeeId: "10874100",
    matchState: "lookup-pending",
    selected: false,
    warnings: [],
  }];

  patchOcrRecordFromEidLookupOutcome(records, 0, {
    workflow: "eid-lookup",
    itemId: "lookup-1",
    runId: "child-1",
    status: "done",
    data: {
      emplId: "10874100",
      activeStatus: "active",
      isActive: "true",
      isHdhAccepted: "true",
      hrStatus: "Active",
      department: "Housing Dining Hospitality",
    },
  }, "verify");

  const rec = records[0] as Record<string, unknown>;
  assert.deepEqual((rec.verification as { state: string }).state, "verified");
});

test("patchOcrRecordFromActiveCheckOutcome verifies active HDH child results", () => {
  const records: unknown[] = [{ employeeId: "10000001", selected: true, warnings: [] }];

  patchOcrRecordFromActiveCheckOutcome(records, 0, {
    workflow: "active-check",
    itemId: "active-1",
    runId: "child-active-1",
    status: "done",
    data: {
      emplId: "10000001",
      activeStatus: "active",
      isActive: "true",
      isHdhAccepted: "true",
      hrStatus: "Active",
      department: "Housing Dining Hospitality",
      personOrgScreenshot: "active.png",
    },
  });

  const rec = records[0] as Record<string, unknown>;
  assert.deepEqual((rec.verification as { state: string }).state, "verified");
  assert.equal(rec.selected, true);
});

test("patchOcrRecordFromActiveCheckOutcome deselects inactive active-check results", () => {
  const records: unknown[] = [{ employeeId: "10000001", selected: true, warnings: [] }];

  patchOcrRecordFromActiveCheckOutcome(records, 0, {
    workflow: "active-check",
    itemId: "active-1",
    runId: "child-active-1",
    status: "done",
    data: {
      emplId: "10000001",
      activeStatus: "inactive",
      isActive: "false",
      isHdhAccepted: "true",
      hrStatus: "Inactive",
      department: "Housing Dining Hospitality",
      terminationDate: "04/30/2026",
    },
  });

  const rec = records[0] as Record<string, unknown>;
  assert.deepEqual((rec.verification as { state: string }).state, "inactive");
  assert.equal(rec.selected, false);
});
