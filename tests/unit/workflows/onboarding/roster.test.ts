import { describe, it, beforeAll, afterAll } from "vitest";
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
  const dir = mkdtempSync(join(tmpdir(), "synthetic-onboarding-roster-"));
  const rosterPath = join(dir, "onboarding.xlsx");
  beforeAll(async () => {
    const workbook = new ExcelJS.Workbook();
    for (const sheetName of ["First cohort", "Second cohort"]) {
      const sheet = workbook.addWorksheet(sheetName);
      sheet.addRow(["Email", "Legal Name", "Lived Name"]);
      for (let i = 0; i < 30; i++) {
        sheet.addRow([`${sheet.id}-${i}@example.edu`, `Example Person ${sheet.id}-${i}`, `Example Preferred ${sheet.id}-${i}`]);
      }
    }
    workbook.worksheets[1].addRow(["fixture029@example.edu", "Kivobolar Cusepaf", "Kut Cusepaf"]);
    await workbook.xlsx.writeFile(rosterPath);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  describe("parseLegalNameComponents", () => {
    it("parses two-token full names into first and last", () => {
      const parsed = parseLegalNameComponents("Kivobolar Cusepaf");
      assert.deepEqual(parsed, {
        firstName: "Kivobolar",
        lastName: "Cusepaf",
      });
    });

    it("parses three-token full names with middle name", () => {
      const parsed = parseLegalNameComponents("Kimi Eakip Iideve");
      assert.deepEqual(parsed, {
        firstName: "Kimi",
        middleName: "Eakip",
        lastName: "Iideve",
      });
    });

    it("anchors compound last names when fallbackLastName is provided", () => {
      const parsed = parseLegalNameComponents("Luzami Cedewem Ruvukim", "Cedewem Ruvukim");
      assert.deepEqual(parsed, {
        firstName: "Luzami",
        middleName: undefined,
        lastName: "Cedewem Ruvukim",
      });
    });

    it("parses comma-separated Last, First Middle names", () => {
      const parsed = parseLegalNameComponents("Cusepaf, Kivobolar Jane");
      assert.deepEqual(parsed, {
        firstName: "Kivobolar",
        middleName: "Jane",
        lastName: "Cusepaf",
      });
    });

    it("throws on empty name", () => {
      assert.throws(() => parseLegalNameComponents("   "), /Cannot parse empty legal name/);
    });
  });

  describe("isCorruptedLivedNameArtifact", () => {
    it("identifies uppercase truncated surname artifact", () => {
      assert.equal(
        isCorruptedLivedNameArtifact("LOCIKDELOSSO Locik De Los Sokamu", "Locik De Los Sokamu"),
        true,
      );
    });

    it("does not flag normal preferred names", () => {
      assert.equal(isCorruptedLivedNameArtifact("Kut Cusepaf", "Cusepaf"), false);
      assert.equal(isCorruptedLivedNameArtifact("Ause Bavecog", "Bavecog"), false);
      assert.equal(isCorruptedLivedNameArtifact("Homeme Locik De Los Sokamu", "Locik De Los Sokamu"), false);
    });

    it("does not flag short all-caps tokens or non-matching tokens", () => {
      assert.equal(isCorruptedLivedNameArtifact("BOB Smith", "Smith"), false);
      assert.equal(isCorruptedLivedNameArtifact("HOMEME Locik", "Locik"), false);
    });
  });

  describe("loadOnboardingRosterEntries on sample roster", () => {

    it("extracts entries with legal and lived names from all sheets", async () => {
      const entries = await loadOnboardingRosterEntries(rosterPath);
      assert.ok(entries.length > 50, `Expected many entries, got ${entries.length}`);

      const kat = entries.find((e) => e.email.toLowerCase() === "fixture029@example.edu");
      assert.ok(kat, "Kivobolar should be found in roster");
      assert.equal(kat.legalName, "Kivobolar Cusepaf");
      assert.equal(kat.livedName, "Kut Cusepaf");
    });
  });

  describe("resolveOnboardingRosterPerson", () => {

    it("resolves legal and lived names for employee present on roster", async () => {
      const resolved = await resolveOnboardingRosterPerson({
        email: "fixture029@example.edu",
        explicitRosterPath: rosterPath,
      });

      assert.deepEqual(resolved.legal, {
        firstName: "Kivobolar",
        lastName: "Cusepaf",
      });
      assert.deepEqual(resolved.preferred, {
        firstName: "Kut",
        lastName: "Cusepaf",
      });
      assert.equal(resolved.rawLegalName, "Kivobolar Cusepaf");
      assert.equal(resolved.rawLivedName, "Kut Cusepaf");
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
