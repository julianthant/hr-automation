import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import {
  findLatestRoster,
  listRosters,
  loadRoster,
} from "../../../../src/workflows/emergency-contact/roster-loader.js";

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

  it("ignores non-xlsx files", async () => {
    const x = join(tmp, "old.xlsx");
    const y = join(tmp, "ignore.txt");
    await writeFakeRoster(x, [{ eid: "1", first: "A", last: "B" }]);
    writeFileSync(y, "noise");
    const r = findLatestRoster(tmp);
    assert.equal(r?.path, x);
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

  it("throws when Employee ID column is missing", async () => {
    const p = join(tmp, "bad.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["Name", "Street"]);
    ws.addRow(["Jane Doe", "123 Main"]);
    await wb.xlsx.writeFile(p);
    await assert.rejects(() => loadRoster(p), /Employee ID/i);
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

  it("skips rows with empty EID or empty name", async () => {
    const p = join(tmp, "skips.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["Employee ID", "First Name", "Last Name"]);
    ws.addRow(["", "Skip", "EmptyEid"]);
    ws.addRow(["10001", "Jane", "Doe"]);
    ws.addRow(["10002", "", ""]);
    await wb.xlsx.writeFile(p);
    const rows = await loadRoster(p);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Jane Doe");
  });
});
