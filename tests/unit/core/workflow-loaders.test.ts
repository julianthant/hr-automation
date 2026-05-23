import { test } from "vitest";
import assert from "node:assert";
import { WORKFLOW_LOADERS, listWorkflowNames } from "../../../src/core/workflow-loaders.js";

test("ocr is NOT in the daemon registry — HTTP-only workflow", () => {
  assert.ok(!("ocr" in WORKFLOW_LOADERS), "OCR should not be daemon-spawnable");
  assert.ok(!listWorkflowNames().includes("ocr"));
});

test("active-check is daemon-spawnable", async () => {
  assert.ok("active-check" in WORKFLOW_LOADERS);
  assert.ok(listWorkflowNames().includes("active-check"));

  const workflow = await WORKFLOW_LOADERS["active-check"]();
  assert.equal(workflow.config.name, "active-check");
});
