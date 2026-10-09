import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { parseAppointmentNumber } from "../../../../src/workflows/onboarding/extract.js";
import { ExtractionError } from "../../../../src/systems/crm/types.js";

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
