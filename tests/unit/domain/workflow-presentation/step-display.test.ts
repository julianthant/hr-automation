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

  it("uses an injected formatter for labels when supplied (3rd param)", () => {
    // The dashboard injects its own `formatStepName`, which differs from the
    // domain default (e.g. "ocr" → "OCR", "auth:ucpath" → "Auth:Ucpath"). Prove
    // the injected formatter — not the domain `formatStepLabel` — drives labels.
    const upper = (s: string) => s.toUpperCase();
    const out = applyStepDisplay(["ocr", "person-lookup"], undefined, upper);
    expect(out.map((s) => s.label)).toEqual(["OCR", "PERSON-LOOKUP"]);
  });

  it("a per-step rule.label still overrides the injected formatter", () => {
    const upper = (s: string) => s.toUpperCase();
    const out = applyStepDisplay(
      ["ocr", "person-lookup"],
      { rules: [{ step: "ocr", label: "Read & match" }] },
      upper,
    );
    expect(out.find((s) => s.step === "ocr")?.label).toBe("Read & match");
    expect(out.find((s) => s.step === "person-lookup")?.label).toBe("PERSON-LOOKUP");
  });
});
