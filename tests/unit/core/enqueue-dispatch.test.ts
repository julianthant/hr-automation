import { test } from "vitest";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineWorkflow } from "../../../src/core/index.js";
import { buildHttpPendingData } from "../../../src/core/daemon/enqueue-dispatch.js";
import { eidLookupCrmWorkflow } from "../../../src/workflows/eid-lookup/workflow.js";

test("buildHttpPendingData: EID lookup HTTP enqueue seeds normalized display data", () => {
  const data = buildHttpPendingData(eidLookupCrmWorkflow, { name: "zaw, hein thant" });

  assert.equal(data.name, "zaw, hein thant");
  assert.equal(data.searchName, "Zaw, Hein Thant");
  assert.equal(data.__name, "Zaw, Hein Thant");
  assert.equal(data.__id, "Zaw, Hein Thant");
  assert.equal(data.__subject, "Zaw, Hein Thant");
});

test("buildHttpPendingData preserves workflow queue title metadata", () => {
  const wf = defineWorkflow({
    name: "queue-title-http-test",
    systems: [],
    steps: ["done"] as const,
    schema: z.object({ name: z.string() }),
    queueTitle: { kind: "single" },
    operatorSubject: (input) => ({ kind: "person", label: input.name }),
    handler: async () => {},
  });

  const data = buildHttpPendingData(wf, { name: "Doe, Jane" });

  assert.equal(data.__queueTitle, "Doe, Jane");
  assert.equal(data.__queueTitleKind, "single");
});

test("eidLookupCrmWorkflow exposes the stable itemId deriver for HTTP enqueue", () => {
  assert.equal(
    eidLookupCrmWorkflow.config.deriveItemId?.({ name: "zaw, hein thant" }),
    "Zaw, Hein Thant",
  );
});
