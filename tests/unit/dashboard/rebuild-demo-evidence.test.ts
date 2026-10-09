import { describe, expect, it } from "vitest";
import { DEMO_ROWS } from "@/components/dev/rebuild-demo/demo-data";
import {
  CAPTURE_STEP_UNSCOPED,
  capturesFor,
  groupCapturesByStep,
  reviewPageFacsimile,
} from "@/components/dev/rebuild-demo/demo-evidence-wire";

describe("rebuild demo — evidence facsimiles are synthetic and complete", () => {
  it("gives every capture in the operator's packet lightbox a page and an extraction record", () => {
    const captures = capturesFor(DEMO_ROWS["oath-summer"]);

    expect(captures.map((capture) => capture.label)).toEqual([
      "Packet page 1",
      "Roster match report",
    ]);
    expect(captures.every((capture) => capture.facsimile)).toBe(true);
    expect(captures.every((capture) => capture.extraction?.fields.length)).toBe(true);
  });

  it("derives every OCR review page from paper facts on that synthetic record", () => {
    const records = DEMO_ROWS["ocr-summer"].records ?? [];

    for (const record of records) {
      const page = reviewPageFacsimile(record);
      const paperValues = record.fields
        .filter((field) => field.source === "paper")
        .map((field) => field.value);
      const drawnValues = page.sections.flatMap((section) => section.fields.map((field) => field.value));

      expect(page.agency).toContain("Synthetic review record");
      expect(drawnValues).toEqual(paperValues);
      expect(page.formTitle).not.toBe("");
    }
  });

  it("groups EC packet captures under OCR extraction", () => {
    const captures = capturesFor(DEMO_ROWS["ec-packet"]);
    expect(captures.every((c) => c.step === "OCR extraction")).toBe(true);

    const groups = groupCapturesByStep(
      captures,
      DEMO_ROWS["ec-packet"].steps?.map((s) => s.label),
    );
    expect(groups.map((g) => g.step)).toEqual(["OCR extraction"]);
    expect(groups[0].captures.map((c) => c.label)).toEqual([
      "Packet page 1",
      "Page 7 (rejected)",
    ]);
  });

  it("orders groups by the run's step list and parks unscoped last", () => {
    const captures = [
      { id: "a", label: "A", kind: "step" as const, failure: false, step: "Rollup" },
      { id: "b", label: "B", kind: "error" as const, failure: true },
      { id: "c", label: "C", kind: "step" as const, failure: false, step: "OCR extraction" },
    ];
    const groups = groupCapturesByStep(captures, ["OCR extraction", "Your review", "Rollup"]);
    expect(groups.map((g) => g.step)).toEqual(["OCR extraction", "Rollup", CAPTURE_STEP_UNSCOPED]);
  });
});
