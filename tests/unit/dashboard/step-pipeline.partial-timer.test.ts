import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeAuthGroupDuration } from "../../../src/dashboard/components/StepPipeline";

describe("computeAuthGroupDuration", () => {
  it("returns undefined when no children have durations", () => {
    const children = [
      { name: "auth:kuali", status: "running" as const, durationMs: undefined },
      { name: "auth:ucpath", status: "pending" as const, durationMs: undefined },
    ];
    assert.strictEqual(computeAuthGroupDuration(children), undefined);
  });

  it("returns total with no suffix when every child has a duration", () => {
    const children = [
      { name: "auth:kuali", status: "completed" as const, durationMs: 1000 },
      { name: "auth:ucpath", status: "completed" as const, durationMs: 2000 },
    ];
    const result = computeAuthGroupDuration(children);
    assert.deepStrictEqual(result, { totalMs: 3000, partial: false });
  });

  it("returns partial total with suffix=true when some children have durations", () => {
    const children = [
      { name: "auth:kuali", status: "completed" as const, durationMs: 1500 },
      { name: "auth:ucpath", status: "running" as const, durationMs: undefined },
    ];
    const result = computeAuthGroupDuration(children);
    assert.deepStrictEqual(result, { totalMs: 1500, partial: true });
  });
});
