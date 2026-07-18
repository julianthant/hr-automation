import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ExcelJS from "exceljs";
import {
  findLatestRoster,
  listRosters,
  loadRoster,
  resolveRosterDirs,
} from "../../../../src/services/matching/roster-loader.js";

async function writeFakeRoster(
  path: string,
  rows: { eid: string; first: string; last: string; street?: string; zip?: string }[],
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Employee ID", "First Name", "Last Name", "Street", "Zip"]);
  for (const r of rows) ws.addRow([r.eid, r.first, r.last, r.street ?? "", r.zip ?? ""]);
  await wb.xlsx.writeFile(path);
}

describe("resolveRosterDirs", () => {
  it("puts the operator's data/rosters first for the DEFAULT tracker root", () => {
    const dirs = resolveRosterDirs(".tracker");
    assert.equal(dirs[0], resolve(process.cwd(), "data", "rosters"));
    assert.ok(dirs.some((d) => d.endsWith(join(".tracker", "rosters"))));
    assert.ok(dirs.some((d) => d.endsWith(join(".tracker", "sharepoint"))));
  });

  // A cwd-anchored `data/rosters` in an ISOLATED root's search path is the
  // ISS-002 hazard: `makeCaptureFinalize` picks the first EXISTING dir, and
  // `data/rosters` always exists in the repo — so it would beat the fixture
  // roster and match a synthetic capture against real employees.
  it("NEVER reaches into data/rosters for a non-default (isolated) tracker root", () => {
    const isolated = mkdtempSync(join(tmpdir(), "iso-tracker-"));
    try {
      const dirs = resolveRosterDirs(isolated);
      const operatorRosters = resolve(process.cwd(), "data", "rosters");
      assert.ok(
        !dirs.includes(operatorRosters),
        `isolated root must not search the operator's ${operatorRosters}`,
      );
      assert.ok(
        dirs.every((d) => d.startsWith(isolated)),
        `every search dir must live under ${isolated}, got ${JSON.stringify(dirs)}`,
      );
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe("findLatestRoster / listRosters", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rost-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when dir is empty", () => {
    assert.equal(findLatestRoster(tmp), null);
    assert.deepEqual(listRosters(tmp), []);
  });

  it("returns null when dir doesn't exist", () => {
    assert.equal(findLatestRoster(join(tmp, "nope")), null);
    assert.deepEqual(listRosters(join(tmp, "nope")), []);
  });

  it("returns the newest .xlsx by mtime", async () => {
    const a = join(tmp, "old.xlsx");
    const b = join(tmp, "new.xlsx");
    await writeFakeRoster(a, [{ eid: "1", first: "A", last: "B" }]);
    await writeFakeRoster(b, [{ eid: "2", first: "C", last: "D" }]);
    utimesSync(a, new Date("2020-01-01"), new Date("2020-01-01"));
    utimesSync(b, new Date("2026-01-01"), new Date("2026-01-01"));
    const r = findLatestRoster(tmp);
    assert.equal(r?.path, b);
  });

  it("ignores non-roster files but lists .csv rosters", async () => {
    const x = join(tmp, "old.xlsx");
    const c = join(tmp, "elections.csv");
    const y = join(tmp, "ignore.txt");
    await writeFakeRoster(x, [{ eid: "1", first: "A", last: "B" }]);
    writeFileSync(c, "Employee Name,Employee ID\n\"Doe, Jane\",10001\n");
    writeFileSync(y, "noise");
    utimesSync(x, new Date("2026-01-02"), new Date("2026-01-02"));
    utimesSync(c, new Date("2026-01-01"), new Date("2026-01-01"));
    const all = listRosters(tmp);
    assert.deepEqual(all.map((r) => r.path), [x, c]);
  });
});

describe("loadRoster", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rost-l-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads First+Last+Employee ID columns", async () => {
    const p = join(tmp, "r.xlsx");
    await writeFakeRoster(p, [
      { eid: "10001", first: "Jane", last: "Doe", street: "123 Main", zip: "80201" },
      { eid: "10002", first: "Bob", last: "Smith" },
    ]);
    const rows = await loadRoster(p);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].eid, "10001");
    assert.equal(rows[0].name, "Jane Doe");
    assert.equal(rows[0].street, "123 Main");
    assert.equal(rows[0].zip, "80201");
    assert.equal(rows[1].name, "Bob Smith");
    assert.equal(rows[1].street, undefined);
  });

  it("supports a name-only roster when Employee ID column is missing", async () => {
    const p = join(tmp, "bad.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["Name", "Street"]);
    ws.addRow(["Jane Doe", "123 Main"]);
    await wb.xlsx.writeFile(p);
    const rows = await loadRoster(p);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].eid, "");
    assert.equal(rows[0].name, "Jane Doe");
    assert.equal(rows[0].street, "123 Main");
  });

  it("supports a single 'Name' column", async () => {
    const p = join(tmp, "named.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["Employee ID", "Name", "Street"]);
    ws.addRow(["10001", "Jane Doe", "123 Main"]);
    await wb.xlsx.writeFile(p);
    const rows = await loadRoster(p);
    assert.equal(rows[0].name, "Jane Doe");
  });

  it("keeps rows with empty EID and skips rows with empty name", async () => {
    const p = join(tmp, "skips.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["Employee ID", "First Name", "Last Name"]);
    ws.addRow(["", "Skip", "EmptyEid"]);
    ws.addRow(["10001", "Jane", "Doe"]);
    ws.addRow(["10002", "", ""]);
    await wb.xlsx.writeFile(p);
    const rows = await loadRoster(p);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].eid, "");
    assert.equal(rows[0].name, "Skip EmptyEid");
    assert.equal(rows[1].name, "Jane Doe");
  });

  it("recognizes an 'Employee Name' column (xlsx)", async () => {
    const p = join(tmp, "empname.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["Employee Name", "Employee ID"]);
    ws.addRow(["Doe, Jane", "10001"]);
    await wb.xlsx.writeFile(p);
    const rows = await loadRoster(p);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Doe, Jane");
    assert.equal(rows[0].eid, "10001");
  });

  // The Employee Action History Report ships "Employee Name Current" — an
  // "existing" roster run picks it up (newest file in data/rosters), so it must
  // load rather than throw "no recognizable header row". Parity with the
  // dedicated action-history parser's HEADER.name.
  it("recognizes an 'Employee Name Current' column (Action History Report shape)", async () => {
    const p = join(tmp, "action-history.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Report Page");
    ws.addRow(["Employee Name Current", "Employee ID", "Job Action"]);
    ws.addRow(["Abramson, Michelle Meili", "10403707", "Termination"]);
    await wb.xlsx.writeFile(p);
    const rows = await loadRoster(p);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Abramson, Michelle Meili");
    assert.equal(rows[0].eid, "10403707");
  });

  it("loads a .csv roster (quoted 'Last, First' names, extra columns, BOM)", async () => {
    // Mirrors the shape of a real OT-elections export: Employee Name /
    // Employee ID plus many unrelated columns, quoted comma names.
    const p = join(tmp, "elections.csv");
    writeFileSync(
      p,
      "﻿Employee Name,Employee ID,Employee Status,Union Code\n" +
        '"Doe, Jane",10001,Active,CX\n' +
        '"Smith, Bob",10002,Active,CX\n' +
        ",99999,Active,CX\n", // no name → skipped
      "utf-8",
    );
    const rows = await loadRoster(p);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, "Doe, Jane");
    assert.equal(rows[0].eid, "10001");
    assert.equal(rows[1].name, "Smith, Bob");
    assert.equal(rows[1].eid, "10002");
  });

  it("csv: finds the header row below decorative preamble rows and reads address columns", async () => {
    const p = join(tmp, "preamble.csv");
    writeFileSync(
      p,
      "Some Export Title,,\n" +
        ",,\n" +
        "First Name,Last Name,Street,City,State,Zip\n" +
        "Jane,Doe,123 Main,San Diego,CA,92101\n",
      "utf-8",
    );
    const rows = await loadRoster(p);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Jane Doe");
    assert.equal(rows[0].street, "123 Main");
    assert.equal(rows[0].zip, "92101");
  });

  it("csv: throws loud on a file with no recognizable header (fail-loud parity with xlsx)", async () => {
    const p = join(tmp, "bogus.csv");
    writeFileSync(p, "colA,colB\n1,2\n", "utf-8");
    await assert.rejects(loadRoster(p), /no recognizable header/);
  });
});
