import { test } from "vitest";
import assert from "node:assert/strict";
import { buildTaskDependenciesHandler } from "../../../../src/tracker/tasks/http.js";

test("task dependency handler returns summary and children for parent run", async () => {
  const handler = buildTaskDependenciesHandler({
    getSummaryByParentRunId: async (parentRunId) => ({
      parentRunId,
      summary: { total: 2, pending: 1, satisfied: 1, failed: 0, cancelled: 0 },
      children: [
        { workflow: "eid-lookup", itemId: "ocr-oath-r0", runId: "child-0", status: "done", metadata: { recordIndex: 0 } },
        { workflow: "eid-lookup", itemId: "ocr-oath-r1", runId: "child-1", status: "queued", metadata: { recordIndex: 1 } },
      ],
    }),
  });

  const result = await handler({ parentRunId: "ocr-run-1" });

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  if (result.body.ok) {
    assert.equal(result.body.summary.total, 2);
    assert.equal(result.body.summary.pending, 1);
  }
});

test("task dependency handler rejects missing parentRunId", async () => {
  const handler = buildTaskDependenciesHandler({
    getSummaryByParentRunId: async () => {
      throw new Error("should not be called");
    },
  });

  const result = await handler({ parentRunId: "" });
  assert.equal(result.status, 400);
});
