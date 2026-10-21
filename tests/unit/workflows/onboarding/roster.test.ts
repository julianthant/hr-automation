import { privateValue } from "../../../../src/private-data.js";
import { beforeAll, afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import {
  parseLegalNameComponents,
  loadOnboardingRosterEntries,
  resolveOnboardingRosterPerson,
  isCorruptedLivedNameArtifact,
} from "../../../../src/workflows/onboarding/roster.js";

describe("onboarding roster resolution", () => {
  const dir = mkdtempSync(join(tmpdir(), "onboarding-roster-test-"));
  const rosterPath = join(dir, "synthetic-roster.xlsx");
  beforeAll(async () => {
    const workbook = new ExcelJS.Workbook();
    for (let page = 0; page < 2; page++) {
      const sheet = workbook.addWorksheet(`Cohort ${page + 1}`);
      sheet.addRow(["Synthetic onboarding roster"]);
      sheet.addRow(["Email", "Legal Name", "Lived Name"]);
      for (let row = 0; row < 30; row++) {
        const id = page * 30 + row;
        sheet.addRow([`student${id}@example.com`, `Student${id} Example`, `Preferred${id} Example`]);
      }
      if (page === 1) sheet.addRow([
        privateValue("email:605c0289942ac641"),
        privateValue("name:a602944e526f2e98"),
        "Kat Clement",
      ]);
    }
    await workbook.xlsx.writeFile(rosterPath);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  describe("parseLegalNameComponents", () => {
    it("parses two-token full names into first and last", () => {
      const parsed = parseLegalNameComponents(privateValue("name:a602944e526f2e98"));
      assert.deepEqual(parsed, {
        firstName: "Kathliyah",
        lastName: "Clement",
      });
    });

    it("parses three-token full names with middle name", () => {
      const parsed = parseLegalNameComponents(privateValue("name:00a2cf7da8d52620"));
      assert.deepEqual(parsed, {
        firstName: "Kyla",
        middleName: "Erine",
        lastName: "Igarta",
      });
    });

    it("anchors compound last names when fallbackLastName is provided", () => {
      const parsed = parseLegalNameComponents(privateValue("name:82cd87b912843097"), "Camargo Ramirez");
      assert.deepEqual(parsed, {
        firstName: "Leslie",
        middleName: undefined,
        lastName: "Camargo Ramirez",
      });
    });

    it("parses comma-separated Last, First Middle names", () => {
      const parsed = parseLegalNameComponents(privateValue("name:b2ca7ea1f6ec0335") + " Jane");
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
      assert.equal(isCorruptedLivedNameArtifact(privateValue("name:313c0700ee56affa"), "Lopez De Los Santos"), false);
    });

    it("does not flag short all-caps tokens or non-matching tokens", () => {
      assert.equal(isCorruptedLivedNameArtifact("BOB Smith", "Smith"), false);
      assert.equal(isCorruptedLivedNameArtifact("HECTOR Lopez", "Lopez"), false);
    });
  });

  describe("loadOnboardingRosterEntries on sample roster", () => {

    it("extracts entries with legal and lived names from all sheets", async () => {
      const entries = await loadOnboardingRosterEntries(rosterPath);
      assert.equal(entries.length, 61);
      assert.ok(entries.some((entry) => entry.email === "student0@example.com"));
      assert.ok(entries.some((entry) => entry.email === "student59@example.com"));

      const kat = entries.find((e) => e.email.toLowerCase() === privateValue("email:605c0289942ac641"));
      assert.ok(kat, "Kathliyah should be found in roster");
      assert.equal(kat.legalName, privateValue("name:a602944e526f2e98"));
      assert.equal(kat.livedName, "Kat Clement");
    });
  });

  describe("resolveOnboardingRosterPerson", () => {

    it("resolves legal and lived names for employee present on roster", async () => {
      const resolved = await resolveOnboardingRosterPerson({
        email: privateValue("email:605c0289942ac641"),
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
      assert.equal(resolved.rawLegalName, privateValue("name:a602944e526f2e98"));
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
