import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { resolveJobSummaryResult } from "../../../../src/workflows/separations/workflow.js";
import type { JobSummaryIdentity } from "../../../../src/systems/ucpath/index.js";

describe("resolveJobSummaryResult", () => {
  it("returns the identity (found + name + data) when fulfilled", () => {
    const value: JobSummaryIdentity = {
      found: true,
      name: "Jayden Balmaceda",
      data: { deptId: "000412", departmentDescription: "XYZ", jobCode: "1234", jobDescription: "Analyst" },
    };
    const result = resolveJobSummaryResult({ status: "fulfilled", value });
    assert.deepStrictEqual(result, value);
  });

  it("passes through a not-found identity (no throw — found:false is a valid branch)", () => {
    const value: JobSummaryIdentity = { found: false, name: "", data: null };
    const result = resolveJobSummaryResult({ status: "fulfilled", value });
    assert.equal(result.found, false);
    assert.equal(result.data, null);
  });

  it("throws with contextual message when rejected (a GENUINE failure, not a miss)", () => {
    assert.throws(
      () => resolveJobSummaryResult({
        status: "rejected",
        reason: new Error("Timeout 10000ms exceeded"),
      }),
      /UCPath Job Summary extraction failed: Timeout 10000ms exceeded/,
    );
  });
});
