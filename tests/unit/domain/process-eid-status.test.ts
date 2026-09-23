import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { processEidStatusExtensions } from "../../../src/domain/process-eid-status.js";

describe("processEidStatusExtensions", () => {
  test("shows terminal assigned EIDs as Found", () => {
    assert.equal(
      processEidStatusExtensions.derivedStatus?.({
        workflow: "process-eid",
        status: "done",
        data: { eidResult: "Found", emplId: "10901366" },
      }),
      "eidFound",
    );
  });

  test("shows a transaction without an assigned EID as Pending, not failed", () => {
    assert.equal(
      processEidStatusExtensions.derivedStatus?.({
        workflow: "process-eid",
        status: "done",
        data: { eidResult: "Pending", emplId: "" },
      }),
      "eidPending",
    );
  });

  test("keeps lookup misses neutral and does not mask real failures", () => {
    assert.equal(
      processEidStatusExtensions.derivedStatus?.({
        workflow: "process-eid",
        status: "done",
        data: { eidResult: "Not found" },
      }),
      "notFound",
    );
    assert.equal(
      processEidStatusExtensions.derivedStatus?.({
        workflow: "process-eid",
        status: "failed",
        data: { eidResult: "Pending" },
      }),
      null,
    );
  });
});
