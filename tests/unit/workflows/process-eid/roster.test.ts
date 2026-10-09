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
    ["Iobub Minecuci", "T009000059", ""],
    ["Heg Sep", "T009000060", "Requested"],
    ["Already Complete", "T009000061", "10090331"],
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
      livedName: "Iobub Minecuci",
      transactionId: "T009000059",
      sheet: "September 14",
      rosterRow: 3,
    },
    {
      source: "person",
      livedName: "Heg Sep",
      transactionId: "T009000060",
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
    ["Segok Yal", "Wulop Yal", "T009000062", "Requested"],
    ["Sepew Nogut", "Sepew Nogut", "T009000068", "Requested"],
    ["Eekivi Witi", "", "T009000070", ""],
  ]);

  const candidates = await loadProcessEidCandidates({
    source: "roster-sheet",
    sheet: "September 14",
    rosterPath,
  });

  assert.deepEqual(candidates, [
    {
      source: "person",
      livedName: "Wulop Yal",
      legalName: "Segok Yal",
      transactionId: "T009000062",
      sheet: "September 14",
      rosterRow: 2,
    },
    {
      source: "person",
      livedName: "Sepew Nogut",
      transactionId: "T009000068",
      sheet: "September 14",
      rosterRow: 3,
    },
    // Lived Name blank → the legal name is the only name, and becomes the row's.
    {
      source: "person",
      livedName: "Eekivi Witi",
      transactionId: "T009000070",
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
      "a@example.com,Guvutoc La,Ruca La,T009000063,Requested",
      'b@example.com,"Aokik, Chaz",Chaz Aokik,T009000064,10090331',
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
      livedName: "Ruca La",
      legalName: "Guvutoc La",
      transactionId: "T009000063",
      sheet: "26-27 Student Applicants(Sept 28).csv",
      rosterRow: 4,
    },
  ]);
});

test("a .csv roster refuses a worksheet label", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "process-eid-roster-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const rosterPath = join(dir, "roster.csv");
  writeFileSync(rosterPath, "Lived Name,Transaction #,EID\nA B,T009000059,\n", "utf8");

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
    ["Iobub Minecuci", "T009000059", ""],
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
    ["", "T009000059", ""],
  ]);

  await assert.rejects(
    loadProcessEidCandidates({
      source: "roster-sheet",
      sheet: "September 14",
      rosterPath,
    }),
    /row 2 has transaction T009000059 but no Lived Name or Legal Name/,
  );
});

test("a repeated transaction fails only its own rows, naming both", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "process-eid-roster-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const rosterPath = join(dir, "Onboarding Roster.xlsx");
  await writeRoster(rosterPath, [
    ["Lived Name", "Transaction Number", "EID"],
    ["Claire Kan", "T009000066", "Requested"],
    ["Lawaza Zap", "T009000066", "Requested"],
    ["Unambiguous Person", "T009000059", "Requested"],
  ]);

  const candidates = await loadProcessEidCandidates({
    source: "roster-sheet",
    sheet: "September 14",
    rosterPath,
  });

  assert.deepEqual(
    candidates.map((c) => [c.livedName, c.rosterRow, Boolean(c.rosterConflict)]),
    [
      ["Claire Kan", 2, true],
      ["Lawaza Zap", 3, true],
      ["Unambiguous Person", 4, false],
    ],
  );
  assert.match(
    candidates[0].rosterConflict ?? "",
    /lists transaction T009000066 on rows 2, 3/,
  );
  assert.equal(candidates[0].rosterConflict, candidates[1].rosterConflict);
});

test("a repeat is caught even when the other occurrence is already assigned", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "process-eid-roster-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const rosterPath = join(dir, "Onboarding Roster.xlsx");
  await writeRoster(rosterPath, [
    ["Lived Name", "Transaction Number", "EID"],
    ["Assigned Person", "T009000059", "10090331"],
    ["Other Person", "T009000059", "Requested"],
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
    /lists transaction T009000059 on rows 2, 3/,
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
