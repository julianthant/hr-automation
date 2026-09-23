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
    ["Hao Sun", "T002235452", "Requested"],
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

test("carries the legal name only when it differs from the lived name", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "process-eid-roster-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const rosterPath = join(dir, "Onboarding Roster.xlsx");
  await writeRoster(rosterPath, [
    ["Legal Name", "Lived Name", "Transaction #", "UCPath ID"],
    ["Siwen Yao", "Wendy Yao", "T002235715", "Requested"],
    ["Sachi Netam", "Sachi Netam", "T002236496", "Requested"],
    ["Esther Wang", "", "T002237975", ""],
  ]);

  const candidates = await loadProcessEidCandidates({
    source: "roster-sheet",
    sheet: "September 14",
    rosterPath,
  });

  assert.deepEqual(candidates, [
    {
      source: "person",
      livedName: "Wendy Yao",
      legalName: "Siwen Yao",
      transactionId: "T002235715",
      sheet: "September 14",
      rosterRow: 2,
    },
    {
      source: "person",
      livedName: "Sachi Netam",
      transactionId: "T002236496",
      sheet: "September 14",
      rosterRow: 3,
    },
    // Lived Name blank → the legal name is the only name, and becomes the row's.
    {
      source: "person",
      livedName: "Esther Wang",
      transactionId: "T002237975",
      sheet: "September 14",
      rosterRow: 4,
    },
  ]);
});

test("reads a .csv roster, labeled by its filename", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "process-eid-roster-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const rosterPath = join(dir, "26-27 Student Applicants(Sept 28).csv");
  writeFileSync(
    rosterPath,
    [
      ",,Dining Services Student Applicants,,",
      ",,,,",
      "Email,Legal Name,Lived Name,Transaction #,UCPath ID",
      "a@example.com,Guangyi Li,Rita Li,T002235943,Requested",
      'b@example.com,"Adams, Chaz",Chaz Adams,T002236424,10901366',
    ].join("\n"),
    "utf8",
  );

  const candidates = await loadProcessEidCandidates({
    source: "roster-sheet",
    rosterPath,
  });

  assert.deepEqual(candidates, [
    {
      source: "person",
      livedName: "Rita Li",
      legalName: "Guangyi Li",
      transactionId: "T002235943",
      sheet: "26-27 Student Applicants(Sept 28).csv",
      rosterRow: 4,
    },
  ]);
});

test("a .csv roster refuses a worksheet label", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "process-eid-roster-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const rosterPath = join(dir, "roster.csv");
  writeFileSync(rosterPath, "Lived Name,Transaction #,EID\nA B,T002235451,\n", "utf8");

  await assert.rejects(
    loadProcessEidCandidates({
      source: "roster-sheet",
      sheet: "Sept 28",
      rosterPath,
    }),
    /\.csv roster holds one table, so worksheet "Sept 28" cannot be selected/,
  );
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

test("fails when a candidate transaction row has no name at all", async (t) => {
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
    /row 2 has transaction T002235451 but no Lived Name or Legal Name/,
  );
});

test("a repeated transaction fails only its own rows, naming both", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "process-eid-roster-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const rosterPath = join(dir, "Onboarding Roster.xlsx");
  await writeRoster(rosterPath, [
    ["Lived Name", "Transaction Number", "EID"],
    ["Claire Kim", "T002236430", "Requested"],
    ["Lyssie Zhu", "T002236430", "Requested"],
    ["Unambiguous Person", "T002235451", "Requested"],
  ]);

  const candidates = await loadProcessEidCandidates({
    source: "roster-sheet",
    sheet: "September 14",
    rosterPath,
  });

  assert.deepEqual(
    candidates.map((c) => [c.livedName, c.rosterRow, Boolean(c.rosterConflict)]),
    [
      ["Claire Kim", 2, true],
      ["Lyssie Zhu", 3, true],
      ["Unambiguous Person", 4, false],
    ],
  );
  assert.match(
    candidates[0].rosterConflict ?? "",
    /lists transaction T002236430 on rows 2, 3/,
  );
  assert.equal(candidates[0].rosterConflict, candidates[1].rosterConflict);
});

test("a repeat is caught even when the other occurrence is already assigned", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "process-eid-roster-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const rosterPath = join(dir, "Onboarding Roster.xlsx");
  await writeRoster(rosterPath, [
    ["Lived Name", "Transaction Number", "EID"],
    ["Assigned Person", "T002235451", "10901366"],
    ["Other Person", "T002235451", "Requested"],
  ]);

  const candidates = await loadProcessEidCandidates({
    source: "roster-sheet",
    sheet: "September 14",
    rosterPath,
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].livedName, "Other Person");
  assert.match(
    candidates[0].rosterConflict ?? "",
    /lists transaction T002235451 on rows 2, 3/,
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
