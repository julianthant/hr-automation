import { test } from "vitest";
import assert from "node:assert/strict";

import { buildWorkflowRailEntryCounts } from "../../../src/dashboard/lib/workflow-rail-counts.js";

test("WorkflowRail counts stay backend-authoritative for the active workflow", () => {
  const counts = buildWorkflowRailEntryCounts({
    wfCounts: {
      ocr: 0,
      "person-lookup": 1,
      "crm-doc-download": 0,
    },
    activeWorkflow: "ocr",
    activeEntriesKey: "ocr|2026-06-02",
    activeQueuePanelTopLevelCount: 1,
  });

  assert.deepEqual(counts, {
    ocr: 0,
    "person-lookup": 1,
    "crm-doc-download": 0,
  });
});
