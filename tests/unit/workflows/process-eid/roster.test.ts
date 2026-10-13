import { privateValue } from "../../../../src/private-data.js";
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
    [privateValue("name:6168ff06af447daa"), "T002235451", ""],
    [privateValue("name:11e6f33fffe74fc2"), "T002235452", "Requested"],
    ["Already Complete", "T002235453", privateValue("id:bf5c81799e6f558c")],
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
      livedName: privateValue("name:6168ff06af447daa"),
      transactionId: "T002235451",
      sheet: "September 14",
      rosterRow: 3,
    },
    {
      source: "person",
      livedName: privateValue("name:11e6f33fffe74fc2"),
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
    [privateValue("name:005effca2a06c79b"), privateValue("name:2577cfc192c1035d"), "T002235715", "Requested"],
    [privateValue("name:83bb613aa947d64e"), privateValue("name:83bb613aa947d64e"), "T002236496", "Requested"],
    [privateValue("name:75e0d631a086c129"), "", "T002237975", ""],
  ]);

  const candidates = await loadProcessEidCandidates({
    source: "roster-sheet",
    sheet: "September 14",
    rosterPath,
  });

  assert.deepEqual(candidates, [
    {
      source: "person",
      livedName: privateValue("name:2577cfc192c1035d"),
      legalName: privateValue("name:005effca2a06c79b"),
      transactionId: "T002235715",
      sheet: "September 14",
      rosterRow: 2,
    },
    {
      source: "person",
      livedName: privateValue("name:83bb613aa947d64e"),
      transactionId: "T002236496",
      sheet: "September 14",
      rosterRow: 3,
    },
    // Lived Name blank → the legal name is the only name, and becomes the row's.
    {
      source: "person",
      livedName: privateValue("name:75e0d631a086c129"),
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
      "a@example.com," + privateValue("name:48ad2576a56f8612") + "," + privateValue("name:d8041f5d6adea3e2") + ",T002235943,Requested",
      'b@example.com,"' + privateValue("name:8bdd424eee0a3844") + '",' + privateValue("name:4d2d12ec1a49ea8a") + ',T002236424,' + privateValue("id:bf5c81799e6f558c"),
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
      livedName: privateValue("name:d8041f5d6adea3e2"),
      legalName: privateValue("name:48ad2576a56f8612"),
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
    [privateValue("name:6168ff06af447daa"), "T002235451", ""],
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
    [privateValue("name:0569fa2f1d01296a"), "T002236430", "Requested"],
    [privateValue("name:5ec6749c7c3b7d6d"), "T002236430", "Requested"],
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
      [privateValue("name:0569fa2f1d01296a"), 2, true],
      [privateValue("name:5ec6749c7c3b7d6d"), 3, true],
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
    ["Assigned Person", "T002235451", privateValue("id:bf5c81799e6f558c")],
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
