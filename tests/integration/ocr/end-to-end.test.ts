import { test } from "node:test";
import assert from "node:assert";
import { ocrWorkflow } from "../../../src/workflows/ocr/index.js";

// Full runWorkflow(ocrWorkflow, ...) e2e is deferred to Phase 4's HTTP-layer
// integration test (which can inject orchestrator overrides). This file
// verifies registration shape only.

test("ocrWorkflow registered with empty systems", () => {
  assert.deepEqual(ocrWorkflow.config.systems, []);
  assert.equal(ocrWorkflow.config.authSteps, false);
  assert.equal(ocrWorkflow.config.name, "ocr");
});

test("ocrWorkflow declares expected steps", () => {
  assert.deepEqual(Array.from(ocrWorkflow.config.steps), [
    "loading-roster",
    "ocr",
    "matching",
    "eid-lookup",
    "verification",
    "awaiting-approval",
  ]);
});
