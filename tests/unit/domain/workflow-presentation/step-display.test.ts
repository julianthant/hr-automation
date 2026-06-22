import { describe, it, expect } from "vitest";
import { applyStepDisplay } from "../../../../src/domain/workflow-presentation/step-display.js";

const steps = ["auth:ucpath", "matching", "disambiguating", "ocr", "awaiting-approval"];

describe("applyStepDisplay", () => {
  it("no config → declared order, formatted labels, no folds", () => {
    const out = applyStepDisplay(steps);
    expect(out.map((s) => s.step)).toEqual(steps);
    expect(out.find((s) => s.step === "awaiting-approval")?.label).toBe("Awaiting Approval");
  });

  it("hidden removes a step from the display list", () => {
    const out = applyStepDisplay(steps, { rules: [{ step: "awaiting-approval", hidden: true }] });
    expect(out.map((s) => s.step)).not.toContain("awaiting-approval");
  });

  it("foldInto absorbs a step into its target's foldedSteps (generalizes OCR folding)", () => {
    const out = applyStepDisplay(steps, {
      rules: [{ step: "matching", foldInto: "ocr" }, { step: "disambiguating", foldInto: "ocr" }],
    });
    expect(out.map((s) => s.step)).not.toContain("matching");
    expect(out.map((s) => s.step)).not.toContain("disambiguating");
    expect(out.find((s) => s.step === "ocr")?.foldedSteps).toEqual(["matching", "disambiguating"]);
  });

  it("order reorders listed steps first, unlisted keep relative order appended", () => {
    const out = applyStepDisplay(["a", "b", "c"], { order: ["c", "a"] });
    expect(out.map((s) => s.step)).toEqual(["c", "a", "b"]);
  });

  it("relabel overrides the displayed label", () => {
    const out = applyStepDisplay(["transaction"], { rules: [{ step: "transaction", label: "Run transaction" }] });
    expect(out[0].label).toBe("Run transaction");
  });
});
