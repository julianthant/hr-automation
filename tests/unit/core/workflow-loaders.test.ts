import { test } from "vitest";
import assert from "node:assert";
import { WORKFLOW_LOADERS, listWorkflowNames } from "../../../src/core/workflow-loaders.js";

test("ocr is NOT in the daemon registry — HTTP-only workflow", () => {
  assert.ok(!("ocr" in WORKFLOW_LOADERS), "OCR should not be daemon-spawnable");
  assert.ok(!listWorkflowNames().includes("ocr"));
});

test("person-lookup is daemon-spawnable", async () => {
  assert.ok("person-lookup" in WORKFLOW_LOADERS);
  assert.ok(listWorkflowNames().includes("person-lookup"));

  const workflow = await WORKFLOW_LOADERS["person-lookup"]();
  assert.equal(workflow.config.name, "person-lookup");
});

test("process-eid is daemon-spawnable and operator-startable", async () => {
  assert.ok("process-eid" in WORKFLOW_LOADERS);
  assert.ok(listWorkflowNames().includes("process-eid"));

  const workflow = await WORKFLOW_LOADERS["process-eid"]();
  assert.equal(workflow.config.name, "process-eid");
  assert.equal(workflow.config.label, "Process EID");
});

test("retired person-match workflow has no daemon-loader alias", () => {
  assert.ok(!("person-match" in WORKFLOW_LOADERS));
  assert.ok(!listWorkflowNames().includes("person-match"));
});
