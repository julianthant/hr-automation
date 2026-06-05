import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { computeStepViews } from "../../../src/dashboard/components/log-panel/StepPipeline";

const OCR_STEPS = [
  "loading-roster",
  "ocr",
  "matching",
  "disambiguating",
  "person-lookup",
  "verification",
  "awaiting-approval",
];

/** Map step name → derived status for terse assertions. */
function statusByName(
  steps: string[],
  currentStep: string | null,
  status: string,
  durations?: Record<string, number>,
): Record<string, string> {
  return Object.fromEntries(
    computeStepViews(steps, currentStep, status, durations).map((v) => [v.name, v.status]),
  );
}

describe("computeStepViews — cancellation recovery", () => {
  it("cancelled at awaiting-approval marks that step cancelled, not step 0", () => {
    // Run reached awaiting-approval, so every earlier step recorded a duration.
    // The cancel sentinel loses the step name; it must be recovered from durations.
    const durations = {
      "loading-roster": 100,
      ocr: 200,
      matching: 300,
      disambiguating: 400,
      "person-lookup": 500,
      verification: 600,
    };
    const s = statusByName(OCR_STEPS, "cancelled", "failed", durations);

    // The reported bug: the highlight must NOT snap back to the first step.
    assert.strictEqual(s["loading-roster"], "completed");
    assert.notStrictEqual(s["loading-roster"], "failed");
    assert.notStrictEqual(s["loading-roster"], "cancelled");

    assert.strictEqual(s["verification"], "completed");
    assert.strictEqual(s["awaiting-approval"], "cancelled");
  });

  it("cancelled mid-run marks the in-flight step (one past the last timed step)", () => {
    // Stopped while on "matching": loading-roster + ocr completed (timed), matching did not.
    const durations = { "loading-roster": 100, ocr: 200 };
    const s = statusByName(OCR_STEPS, "cancelled", "failed", durations);

    assert.strictEqual(s["loading-roster"], "completed");
    assert.strictEqual(s["ocr"], "completed");
    assert.strictEqual(s["matching"], "cancelled");
    assert.strictEqual(s["disambiguating"], "pending");
    assert.strictEqual(s["awaiting-approval"], "pending");
  });

  it("cancelled before any step completes marks step 0 cancelled (not failed)", () => {
    const s = statusByName(OCR_STEPS, "cancelled", "failed", {});
    assert.strictEqual(s["loading-roster"], "cancelled");
    assert.strictEqual(s["ocr"], "pending");
  });

  it("never reports more than one cancelled step", () => {
    const durations = { "loading-roster": 100, ocr: 200, matching: 300 };
    const views = computeStepViews(OCR_STEPS, "cancelled", "failed", durations);
    assert.strictEqual(views.filter((v) => v.status === "cancelled").length, 1);
  });
});

describe("computeStepViews — non-cancelled behavior preserved", () => {
  it("failed with an unknown/missing step still falls back to step 0 as failed", () => {
    const s = statusByName(OCR_STEPS, null, "failed", {});
    assert.strictEqual(s["loading-roster"], "failed");
    assert.strictEqual(s["ocr"], "pending");
  });

  it("running highlights the reported step; earlier complete, later pending", () => {
    const s = statusByName(OCR_STEPS, "matching", "running", {
      "loading-roster": 100,
      ocr: 200,
    });
    assert.strictEqual(s["loading-roster"], "completed");
    assert.strictEqual(s["ocr"], "completed");
    assert.strictEqual(s["matching"], "running");
    assert.strictEqual(s["disambiguating"], "pending");
  });

  it("done marks every step completed", () => {
    const s = statusByName(["a", "b", "c"], "c", "done", { a: 1, b: 2, c: 3 });
    assert.strictEqual(s["a"], "completed");
    assert.strictEqual(s["b"], "completed");
    assert.strictEqual(s["c"], "completed");
  });
});
