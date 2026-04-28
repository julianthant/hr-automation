import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatCrmDateAsMmDdYyyy } from "../../../../src/systems/crm/onboarding-history.js";

describe("formatCrmDateAsMmDdYyyy", () => {
  it("pads single-digit month + day to two digits", () => {
    assert.equal(formatCrmDateAsMmDdYyyy("4/27/2026 1:26 PM"), "04/27/2026");
    assert.equal(formatCrmDateAsMmDdYyyy("4/7/2026 1:26 PM"), "04/07/2026");
  });

  it("leaves two-digit month + day untouched", () => {
    assert.equal(formatCrmDateAsMmDdYyyy("10/15/2026 11:30 AM"), "10/15/2026");
    assert.equal(formatCrmDateAsMmDdYyyy("12/31/2026 11:59 PM"), "12/31/2026");
  });

  it("ignores trailing time portion", () => {
    assert.equal(formatCrmDateAsMmDdYyyy("4/27/2026"), "04/27/2026");
    assert.equal(formatCrmDateAsMmDdYyyy("4/27/2026 1:26 PM PDT"), "04/27/2026");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(formatCrmDateAsMmDdYyyy("  4/27/2026 1:26 PM  "), "04/27/2026");
  });

  it("returns null on garbled input", () => {
    assert.equal(formatCrmDateAsMmDdYyyy(""), null);
    assert.equal(formatCrmDateAsMmDdYyyy("Apr 27, 2026"), null);
    assert.equal(formatCrmDateAsMmDdYyyy("not-a-date"), null);
    assert.equal(formatCrmDateAsMmDdYyyy("4-27-2026"), null);
  });
});
