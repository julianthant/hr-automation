import { test } from "vitest";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineWorkflow } from "../../../src/core/index.js";
import { buildHttpPendingData } from "../../../src/core/daemon/enqueue-dispatch.js";
import { activeCheckWorkflow } from "../../../src/workflows/active-check/workflow.js";
import { eidLookupCrmWorkflow } from "../../../src/workflows/eid-lookup/workflow.js";
import { separationsWorkflow } from "../../../src/workflows/separations/workflow.js";

test("buildHttpPendingData: EID lookup HTTP enqueue seeds normalized display data", () => {
  const data = buildHttpPendingData(eidLookupCrmWorkflow, { name: "zaw, hein thant" });

  assert.equal(data.name, "zaw, hein thant");
  assert.equal(data.searchName, "Zaw, Hein Thant");
  assert.equal(data.__name, "Zaw, Hein Thant");
  assert.equal(data.__id, "Zaw, Hein Thant");
  assert.equal(data.__subject, "Zaw, Hein Thant");
});

test("buildHttpPendingData: active-check HTTP enqueue uses person/EID title without workflow prefix", () => {
  const byName = buildHttpPendingData(activeCheckWorkflow, { name: "agook, martha" });
  const byEid = buildHttpPendingData(activeCheckWorkflow, { emplId: "10733938" });

  assert.equal(byName.__subject, "Agook, Martha");
  assert.equal(byName.__queueTitle, "Agook, Martha");
  assert.equal(byName.__name, "Agook, Martha");
  assert.equal(byEid.__subject, "EID 10733938");
  assert.equal(byEid.__queueTitle, "EID 10733938");
  assert.equal(byEid.__name, "10733938");
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

test("buildHttpPendingData stamps a single separation enqueue as a single row", () => {
  const data = buildHttpPendingData(separationsWorkflow, { docId: "4025" });

  assert.equal(data.docId, "4025");
  assert.equal(data.__subject, "Separation 4025");
  assert.equal(data.archetype, "single");
});

test("buildHttpPendingData honors direct input-run batch row-shape hint", () => {
  const data = buildHttpPendingData(
    eidLookupCrmWorkflow,
    { name: "Doe, Jane", __runtimeOptions: { rowShape: "batch-member" } },
    "input-run-batch-1",
  );

  assert.equal(data.searchName, "Doe, Jane");
  assert.equal(data.archetype, "batch-member");
});

test("eidLookupCrmWorkflow exposes the stable itemId deriver for HTTP enqueue", () => {
  assert.equal(
    eidLookupCrmWorkflow.config.deriveItemId?.({ name: "zaw, hein thant" }),
    "Zaw, Hein Thant",
  );
});
