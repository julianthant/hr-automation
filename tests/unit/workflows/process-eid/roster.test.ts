import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  findLatestProcessEidRosterPath,
  loadProcessEidCandidates,
} from "../../../../src/workflows/process-eid/roster.js";
import { rostersDir } from "../../../../src/tracker/paths.js";

async function writeRoster(
  path: string,
  rows: unknown[][],
  sheetName = "September 14",
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName);
  for (const row of rows) worksheet.addRow(row);
  await workbook.xlsx.writeFile(path);
}

test("loads only rows with a transaction number and no assigned EID", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "process-eid-roster-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const rosterPath = join(dir, "Onboarding Roster.xlsx");
  await writeRoster(rosterPath, [
    ["Onboarding roster"],
    ["Lived Name", "UCPath Transaction Number", "UCPath ID"],
    ["Ineza Marekani", "T002235451", ""],
    ["Hao Sun", "T002235452", "Pending"],
    ["Already Complete", "T002235453", "10901366"],
    ["No Transaction", "", ""],
  ]);

  const candidates = await loadProcessEidCandidates({
    source: "roster-sheet",
    sheet: " september   14 ",
    rosterPath,
  });

  assert.deepEqual(candidates, [
    {
      source: "person",
      livedName: "Ineza Marekani",
      transactionId: "T002235451",
      sheet: "September 14",
      rosterRow: 3,
    },
    {
      source: "person",
      livedName: "Hao Sun",
      transactionId: "T002235452",
      sheet: "September 14",
      rosterRow: 4,
    },
  ]);
});

test("fails when the requested worksheet label does not resolve exactly", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "process-eid-roster-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const rosterPath = join(dir, "Onboarding Roster.xlsx");
  await writeRoster(rosterPath, [
    ["Lived Name", "Transaction Number", "EID"],
    ["Ineza Marekani", "T002235451", ""],
  ]);

  await assert.rejects(
    loadProcessEidCandidates({
      source: "roster-sheet",
      sheet: "September 15",
      rosterPath,
    }),
    /expected exactly one worksheet named "September 15", found 0/,
  );
});

test("fails when a candidate transaction row has no lived name", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "process-eid-roster-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const rosterPath = join(dir, "Onboarding Roster.xlsx");
  await writeRoster(rosterPath, [
    ["Lived Name", "Transaction Number", "EID"],
    ["", "T002235451", ""],
  ]);

  await assert.rejects(
    loadProcessEidCandidates({
      source: "roster-sheet",
      sheet: "September 14",
      rosterPath,
    }),
    /row 2 has transaction T002235451 but no Lived Name/,
  );
});

test("newest-roster discovery ignores Excel temporary lock files", (t) => {
  const trackerDir = mkdtempSync(join(tmpdir(), "process-eid-roster-"));
  t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }));
  const rosterDirectory = rostersDir(trackerDir);
  mkdirSync(rosterDirectory, { recursive: true });
  const rosterPath = join(rosterDirectory, "Onboarding Roster.xlsx");
  const lockPath = join(rosterDirectory, "~$Onboarding Roster.xlsx");
  writeFileSync(rosterPath, "real");
  writeFileSync(lockPath, "lock");
  const now = new Date();
  utimesSync(rosterPath, now, now);
  const newer = new Date(now.getTime() + 1_000);
  utimesSync(lockPath, newer, newer);

  assert.equal(findLatestProcessEidRosterPath(trackerDir), rosterPath);
});
