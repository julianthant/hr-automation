import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseWorkflowDefinitionsResponse } from "../../../src/dashboard/lib/workflows-context.js";

describe("parseWorkflowDefinitionsResponse", () => {
  it("throws a clear error when the workflow definitions payload is not an array", () => {
    assert.throws(
      () => parseWorkflowDefinitionsResponse({ error: "boom" }),
      /workflow-definitions: expected array, got object/,
    );
  });

  it("returns validated workflow definitions", () => {
    const payload = [{ name: "ocr", label: "OCR", steps: [], systems: [], detailFields: [] }];

    assert.deepEqual(parseWorkflowDefinitionsResponse(payload), payload);
  });
});
