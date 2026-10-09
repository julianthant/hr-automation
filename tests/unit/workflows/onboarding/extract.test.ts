import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { parseAppointmentNumber } from "../../../../src/workflows/onboarding/extract.js";
import { ExtractionError } from "../../../../src/systems/crm/types.js";

describe("extractRawFields", () => {
  it("extracts Address Line 2 independently of Address Line 1 and normalizes empty placeholders", async (t) => {
    vi.resetModules();
    const extractField = vi.fn(async (_page: Page, _label: string): Promise<string | null> => null);
    vi.doMock("../../../../src/systems/crm/extract.js", () => ({ extractField }));
    t.onTestFinished(() => {
      vi.doUnmock("../../../../src/systems/crm/extract.js");
      vi.resetModules();
    });
    const { extractRawFields } = await import("../../../../src/workflows/onboarding/extract.js");
    for (const address2 of ["30037", "Apt 2B", "N/A", null]) {
      extractField.mockImplementation(async (_page, label) => {
        if (label === "Address Line 1") return "9450 Example Rd";
        if (label === "Address Line 2") return address2;
        return null;
      });
      const raw = await extractRawFields({} as Page);
      assert.equal(raw.address, "9450 Example Rd");
      assert.equal(raw.address2, address2 === "N/A" ? "" : address2);
    }
  });
});

/**
 * `parseAppointmentNumber` is the pure logic behind the appointment field of
 * `extractRawFields` (which itself drives a real Playwright Page and is out of
 * scope for unit tests -- see tests/CLAUDE.md). Its result becomes
 * `data.appointment`, which `enter.ts` fills verbatim into UCPath's live
 * "Employee Classification" field on the Smart HR transaction, so an unmapped
 * raw label must fail loud instead of shipping through as a classification
 * code.
 */
describe("parseAppointmentNumber", () => {
  it("parses just the number out of a label like 'Casual/Restricted 5'", () => {
    assert.equal(parseAppointmentNumber("Casual/Restricted 5"), "5");
  });

  it("parses a bare numeric label", () => {
    assert.equal(parseAppointmentNumber("5"), "5");
  });

  it("throws instead of shipping an unmapped raw label as the classification code", () => {
    assert.throws(
      () => parseAppointmentNumber("Volunteer (Unpaid)"),
      (err: unknown) => {
        assert.ok(err instanceof ExtractionError);
        assert.ok(err.failedFields?.includes("appointment"));
        assert.match(err.message, /Volunteer \(Unpaid\)/);
        return true;
      },
    );
  });

  it("throws on a label with no digits at all, not just non-numeric noise", () => {
    assert.throws(
      () => parseAppointmentNumber("Casual/Restricted"),
      (err: unknown) => err instanceof ExtractionError,
    );
  });
});
