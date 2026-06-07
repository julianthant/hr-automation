import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  computeOcrPipelineView,
  computeStepViews,
} from "../../../src/dashboard/components/log-panel/StepPipeline";

// The real OCR step list (workflow.ts `ocrSteps`). `matching` + `disambiguating`
// were merged into the single `ocr` step; `verification` was retired earlier
// (person-lookup owns verification now). A standalone run ends `done` at
// person-lookup and only DELEGATED runs reach `awaiting-approval`.
const OCR_STEPS = [
  "loading-roster",
  "ocr",
  "person-lookup",
  "awaiting-approval",
];

/** Derived chip status per visible step, after the OCR pipeline filter. */
function derived(
  steps: string[],
  currentStep: string | null,
  status: string,
  isDelegated: boolean,
  durations?: Record<string, number>,
): Record<string, string> {
  const v = computeOcrPipelineView(steps, currentStep, status, isDelegated);
  return Object.fromEntries(
    computeStepViews(v.steps, v.currentStep, v.status, durations).map((s) => [s.name, s.status]),
  );
}

describe("computeOcrPipelineView", () => {
  it("standalone (non-approve) hides awaiting-approval — pipeline ends at person-lookup", () => {
    const v = computeOcrPipelineView(OCR_STEPS, "person-lookup", "running", false);
    assert.deepEqual(v.steps, ["loading-roster", "ocr", "person-lookup"]);
  });

  it("delegated (approve) keeps awaiting-approval", () => {
    const v = computeOcrPipelineView(OCR_STEPS, "awaiting-approval", "running", true);
    assert.deepEqual(v.steps, ["loading-roster", "ocr", "person-lookup", "awaiting-approval"]);
  });

  it("standalone DONE (completed after person-lookup) → every visible chip complete", () => {
    const d = derived(OCR_STEPS, null, "done", false);
    assert.equal(d["person-lookup"], "completed");
    assert.equal(d["loading-roster"], "completed");
    assert.equal(d["awaiting-approval"], undefined); // hidden
  });

  it("delegated parked at awaiting-approval → it renders active, earlier complete", () => {
    const d = derived(OCR_STEPS, "awaiting-approval", "running", true);
    assert.equal(d["person-lookup"], "completed");
    assert.equal(d["awaiting-approval"], "running");
  });

  it("an active visible step passes through unchanged", () => {
    const d = derived(OCR_STEPS, "ocr", "running", false);
    assert.equal(d["ocr"], "running");
    assert.equal(d["loading-roster"], "completed");
    assert.equal(d["person-lookup"], "pending");
  });

  it("failure on a visible step passes through", () => {
    const d = derived(OCR_STEPS, "ocr:failed:timeout", "failed", false);
    assert.equal(d["ocr"], "failed");
    assert.equal(d["loading-roster"], "completed");
  });

  // ── Merged sub-phases: `matching` / `disambiguating` fold into `ocr` ────────

  it("a row reported at `matching` folds onto the merged `ocr` step", () => {
    const d = derived(OCR_STEPS, "matching", "running", false);
    assert.equal(d["ocr"], "running");
    assert.equal(d["loading-roster"], "completed");
    assert.equal(d["person-lookup"], "pending");
    assert.equal(d["matching"], undefined); // not a visible step
  });

  it("a row reported at `disambiguating` folds onto `ocr`", () => {
    const d = derived(OCR_STEPS, "disambiguating", "running", false);
    assert.equal(d["ocr"], "running");
    assert.equal(d["person-lookup"], "pending");
  });

  it("a failure during `matching`/`disambiguating` surfaces on the merged `ocr` step", () => {
    const d = derived(OCR_STEPS, "disambiguating:failed:boom", "failed", false);
    assert.equal(d["ocr"], "failed");
  });

  // ── Legacy rows still carrying the retired `verification` step ──────────────

  it("legacy: standalone parked at the retired verification step → all visible complete", () => {
    const d = derived(OCR_STEPS, "verification", "running", false);
    assert.equal(d["person-lookup"], "completed");
    assert.equal(d["verification"], undefined); // not a visible step
    assert.equal(d["awaiting-approval"], undefined); // hidden
  });

  it("legacy: delegated at verification → advances highlight to awaiting-approval", () => {
    const d = derived(OCR_STEPS, "verification", "running", true);
    assert.equal(d["person-lookup"], "completed");
    assert.equal(d["awaiting-approval"], "running");
  });

  it("legacy: failure on the retired verification step surfaces on person-lookup", () => {
    const d = derived(OCR_STEPS, "verification:failed:boom", "failed", false);
    assert.equal(d["person-lookup"], "failed");
  });
});
