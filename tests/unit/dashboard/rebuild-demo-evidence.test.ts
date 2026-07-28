import { describe, expect, it } from "vitest";
import { DEMO_ROWS } from "@/components/dev/rebuild-demo/demo-data";
import {
  capturesFor,
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
});
