import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OathSignatureInputSchema } from "../../../../src/workflows/oath-signature/schema.js";
import {
  ensurePersonProfilesSearchForm,
  shouldCommitOathSignature,
} from "../../../../src/workflows/oath-signature/enter.js";

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

describe("ensurePersonProfilesSearchForm", () => {
  it("clicks Return to Search when Person Profiles reopens on a stale detail page", async () => {
    const events: string[] = [];
    let searchVisible = false;

    const makeLocator = (kind: "search" | "return") => ({
      isVisible: async () => (kind === "search" ? searchVisible : !searchVisible),
      waitFor: async () => {
        if (!searchVisible) throw new Error("search form still hidden");
      },
      click: async () => {
        events.push("return-clicked");
        searchVisible = true;
      },
    });

    const frame = {
      getByRole: (_role: string, opts: { name?: string }) => {
        if (opts.name === "Empl ID") return makeLocator("search");
        if (opts.name === "Return to Search") return makeLocator("return");
        throw new Error(`unexpected locator ${String(opts.name)}`);
      },
    };
    const page = {
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
    };

    await ensurePersonProfilesSearchForm(page as never, frame as never);

    assert.deepEqual(events, ["return-clicked"]);
    assert.equal(searchVisible, true);
  });
});
