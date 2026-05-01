import { test } from "node:test";
import assert from "node:assert";
import { WORKFLOW_LOADERS, listWorkflowNames } from "../../../src/core/workflow-loaders.js";

test("ocr is NOT in the daemon registry — HTTP-only workflow", () => {
  assert.ok(!("ocr" in WORKFLOW_LOADERS), "OCR should not be daemon-spawnable");
  assert.ok(!listWorkflowNames().includes("ocr"));
});
