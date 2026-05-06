import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHttpPendingData } from "../../../src/core/daemon/enqueue-dispatch.js";
import { eidLookupCrmWorkflow } from "../../../src/workflows/eid-lookup/workflow.js";

test("buildHttpPendingData: EID lookup HTTP enqueue seeds normalized display data", () => {
  const data = buildHttpPendingData(eidLookupCrmWorkflow, { name: "zaw, hein thant" });

  assert.equal(data.name, "zaw, hein thant");
  assert.equal(data.searchName, "Zaw, Hein Thant");
  assert.equal(data.__name, "Zaw, Hein Thant");
  assert.equal(data.__id, "Zaw, Hein Thant");
  assert.equal(data.__subject, "EID Lookup Zaw, Hein Thant");
});

test("eidLookupCrmWorkflow exposes the stable itemId deriver for HTTP enqueue", () => {
  assert.equal(
    eidLookupCrmWorkflow.config.deriveItemId?.({ name: "zaw, hein thant" }),
    "Zaw, Hein Thant",
  );
});
