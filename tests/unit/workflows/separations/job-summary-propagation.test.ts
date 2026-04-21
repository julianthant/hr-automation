import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveJobSummaryResult } from "../../../../src/workflows/separations/workflow.js";

describe("resolveJobSummaryResult", () => {
  it("returns the value when fulfilled", () => {
    const result = resolveJobSummaryResult({
      status: "fulfilled",
      value: { departmentDescription: "XYZ", jobCode: "1234", jobDescription: "Analyst" } as unknown as import("../../../../src/systems/ucpath/index.js").JobSummaryData,
    });
    assert.deepStrictEqual(result, {
      departmentDescription: "XYZ", jobCode: "1234", jobDescription: "Analyst",
    });
  });

  it("throws with contextual message when rejected", () => {
    assert.throws(
      () => resolveJobSummaryResult({
        status: "rejected",
        reason: new Error("Timeout 10000ms exceeded"),
      }),
      /UCPath Job Summary extraction failed: Timeout 10000ms exceeded/,
    );
  });
});
