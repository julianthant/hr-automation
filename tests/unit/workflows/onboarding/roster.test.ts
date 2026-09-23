import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  parseLegalNameComponents,
  loadOnboardingRosterEntries,
  resolveOnboardingRosterPerson,
  isCorruptedLivedNameArtifact,
} from "../../../../src/workflows/onboarding/roster.js";

describe("onboarding roster resolution", () => {
  describe("parseLegalNameComponents", () => {
    it("parses two-token full names into first and last", () => {
      const parsed = parseLegalNameComponents("Kathliyah Clement");
      assert.deepEqual(parsed, {
        firstName: "Kathliyah",
        lastName: "Clement",
      });
    });

    it("parses three-token full names with middle name", () => {
      const parsed = parseLegalNameComponents("Kyla Erine Igarta");
      assert.deepEqual(parsed, {
        firstName: "Kyla",
        middleName: "Erine",
        lastName: "Igarta",
      });
    });

    it("anchors compound last names when fallbackLastName is provided", () => {
      const parsed = parseLegalNameComponents("Leslie Camargo Ramirez", "Camargo Ramirez");
      assert.deepEqual(parsed, {
        firstName: "Leslie",
        middleName: undefined,
        lastName: "Camargo Ramirez",
      });
    });

    it("parses comma-separated Last, First Middle names", () => {
      const parsed = parseLegalNameComponents("Clement, Kathliyah Jane");
      assert.deepEqual(parsed, {
        firstName: "Kathliyah",
        middleName: "Jane",
        lastName: "Clement",
      });
    });

    it("throws on empty name", () => {
      assert.throws(() => parseLegalNameComponents("   "), /Cannot parse empty legal name/);
    });
  });

  describe("isCorruptedLivedNameArtifact", () => {
    it("identifies uppercase truncated surname artifact", () => {
      assert.equal(
        isCorruptedLivedNameArtifact("LOPEZDELOSSAN Lopez De Los Santos", "Lopez De Los Santos"),
        true,
      );
    });

    it("does not flag normal preferred names", () => {
      assert.equal(isCorruptedLivedNameArtifact("Kat Clement", "Clement"), false);
      assert.equal(isCorruptedLivedNameArtifact("Alex Bonilla", "Bonilla"), false);
      assert.equal(isCorruptedLivedNameArtifact("Hector Lopez De Los Santos", "Lopez De Los Santos"), false);
    });

    it("does not flag short all-caps tokens or non-matching tokens", () => {
      assert.equal(isCorruptedLivedNameArtifact("BOB Smith", "Smith"), false);
      assert.equal(isCorruptedLivedNameArtifact("HECTOR Lopez", "Lopez"), false);
    });
  });

  describe("loadOnboardingRosterEntries on sample roster", () => {
    const rosterPath = resolve(process.cwd(), "data/rosters/OnboardingRoster-2026-09-09T21-05-59.xlsx");

    it("extracts entries with legal and lived names from all sheets", async () => {
      const entries = await loadOnboardingRosterEntries(rosterPath);
      assert.ok(entries.length > 50, `Expected many entries, got ${entries.length}`);

      const kat = entries.find((e) => e.email.toLowerCase() === "kathliyahc2007@gmail.com");
      assert.ok(kat, "Kathliyah should be found in roster");
      assert.equal(kat.legalName, "Kathliyah Clement");
      assert.equal(kat.livedName, "Kat Clement");
    });
  });

  describe("resolveOnboardingRosterPerson", () => {
    const rosterPath = resolve(process.cwd(), "data/rosters/OnboardingRoster-2026-09-09T21-05-59.xlsx");

    it("resolves legal and lived names for employee present on roster", async () => {
      const resolved = await resolveOnboardingRosterPerson({
        email: "kathliyahc2007@gmail.com",
        explicitRosterPath: rosterPath,
      });

      assert.deepEqual(resolved.legal, {
        firstName: "Kathliyah",
        lastName: "Clement",
      });
      assert.deepEqual(resolved.preferred, {
        firstName: "Kat",
        lastName: "Clement",
      });
      assert.equal(resolved.rawLegalName, "Kathliyah Clement");
      assert.equal(resolved.rawLivedName, "Kat Clement");
    });

    it("triggers SharePoint fresh download when email is not on local roster", async () => {
      let downloadTriggered = false;
      const downloadFn = async (opts: { id: string; mode: "fresh" }) => {
        downloadTriggered = true;
        assert.equal(opts.id, "onboarding");
        assert.equal(opts.mode, "fresh");
        return { path: rosterPath };
      };

      await assert.rejects(
        async () => {
          await resolveOnboardingRosterPerson({
            email: "notonroster@example.com",
            explicitRosterPath: rosterPath,
            sharePointDownloadFn: downloadFn,
          });
        },
        /Employee "notonroster@example.com" was not found on the onboarding roster/,
      );

      assert.equal(downloadTriggered, true, "Fresh SharePoint download should have been triggered");
    });
  });
});
