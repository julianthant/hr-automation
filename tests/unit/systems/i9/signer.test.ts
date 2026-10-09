import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { extractSignedSection2Signer } from "../../../../src/systems/i9/signer.js";

describe("extractSignedSection2Signer", () => {
  it("reads the signer from the Created By audit-trail cell", () => {
    const signer = extractSignedSection2Signer([
      "2",
      "10/29/2021 7:53:31 PM",
      "Signed Section 2",
      "KENIA QUINONEZ",
    ]);

    assert.equal(signer, "KENIA QUINONEZ");
  });

  it("returns null when the Created By cell is blank", () => {
    const signer = extractSignedSection2Signer([
      "2",
      "10/29/2021 7:53:31 PM",
      "Signed Section 2",
      "  ",
    ]);

    assert.equal(signer, null);
  });
});
