import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { displayEid, normalizeEid } from "../../../src/domain/identity/eid.js";

describe("EID helpers", () => {
  it("keeps only digits for normalized EID comparison", () => {
    assert.equal(normalizeEid(" Empl ID: 00123456 "), "00123456");
  });

  it("returns empty string for missing EID", () => {
    assert.equal(normalizeEid(null), "");
    assert.equal(normalizeEid(undefined), "");
  });

  it("formats operator display with EID prefix only when present", () => {
    assert.equal(displayEid("00123456"), "EID 00123456");
    assert.equal(displayEid(""), "");
  });
});
