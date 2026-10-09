import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  isOathSignatureSkipped,
  oathSignatureStatusExtensions,
} from "../../../src/domain/oath-signature-status.js";

/**
 * Oath-signature marks intentionally-skipped rows with `data.skipped === "true"`
 * and returns cleanly (row is mechanically `done`). The status extension
 * promotes those to the muted "Skipped" badge; a real done/failed row is left
 * untouched.
 */

describe("isOathSignatureSkipped", () => {
  it("is true only for data.skipped === 'true'", () => {
    assert.equal(isOathSignatureSkipped({ data: { skipped: "true" } }), true);
    assert.equal(isOathSignatureSkipped({ data: { skipped: "false" } }), false);
    assert.equal(isOathSignatureSkipped({ data: {} }), false);
    assert.equal(isOathSignatureSkipped({}), false);
  });
});

describe("oathSignatureStatusExtensions.derivedStatus", () => {
  const derive = (data: Record<string, string>): string | null =>
    oathSignatureStatusExtensions.derivedStatus!({
      workflow: "oath-signature",
      status: "done",
      data,
    });

  it("derives 'skipped' for a skipped row (any reason)", () => {
    assert.equal(derive({ skipped: "true", skipReason: "No CRM onboarding record" }), "skipped");
    assert.equal(derive({ skipped: "true", skipReason: "Oath already on file", date: "07/02/2026" }), "skipped");
  });

  it("leaves a normal completed row on its base status", () => {
    assert.equal(derive({ crmOnboarding: "Verified (Completed)", date: "07/01/2026" }), null);
    assert.equal(derive({}), null);
  });
});
