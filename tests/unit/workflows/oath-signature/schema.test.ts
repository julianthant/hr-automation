import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OathSignatureInputSchema } from "../../../../src/workflows/oath-signature/schema.js";
import { shouldCommitOathSignature } from "../../../../src/workflows/oath-signature/enter.js";

describe("OathSignatureInputSchema", () => {
  it("accepts dryRun", () => {
    const parsed = OathSignatureInputSchema.parse({ emplId: "10706431", dryRun: true });
    assert.equal(parsed.dryRun, true);
  });
});

describe("shouldCommitOathSignature", () => {
  it("does not commit during dry run", () => {
    assert.equal(
      shouldCommitOathSignature({ emplId: "10706431", dryRun: true }, { alreadyHasOath: false }),
      false,
    );
  });

  it("does not commit when an oath already exists", () => {
    assert.equal(
      shouldCommitOathSignature({ emplId: "10706431" }, { alreadyHasOath: true }),
      false,
    );
  });

  it("commits only for a real run that needs a new oath", () => {
    assert.equal(
      shouldCommitOathSignature({ emplId: "10706431" }, { alreadyHasOath: false }),
      true,
    );
  });
});
