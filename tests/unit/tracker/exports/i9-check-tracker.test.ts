/**
 * Master I-9 retention tracker — the 5-year retention rule + the single-sheet
 * append (header creation, text-format PPS EIDs, lock serialization,
 * always-append re-run semantics).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";

import {
  I9_CHECK_SHEET_NAME,
  I9_CHECK_TRACKER_COLUMNS,
  appendI9CheckTrackerRow,
  decideI9RetentionAction,
  type I9CheckTrackerRow,
} from "../../../../src/tracker/exports/i9-check-tracker.js";

const TODAY = new Date(2026, 6, 16); // 7/16/2026 local

function baseRow(over: Partial<I9CheckTrackerRow>): I9CheckTrackerRow {
  return {
    employeeName: "Vega, Omar",
    ppsEid: "000039549",
    ucpathEmplId: "10458971",
    hireDate: "4/17/2018",
    separationDate: "8/6/2021",
    foundInUcpath: "Yes",
    action: "Shred",
    reviewerName: "Julian",
    notes: "",
    ...over,
  };
}

describe("decideI9RetentionAction", () => {
  it("not found in UCPath → Shred", () => {
    const d = decideI9RetentionAction({ found: false, hasRosterRow: false, today: TODAY });
    assert.equal(d.action, "Shred");
    assert.equal(d.foundLabel, "Not found in UCPath");
    assert.equal(d.note, "");
  });

  it("found + separation more than 5 years ago → Shred", () => {
    const d = decideI9RetentionAction({
      found: true,
      hasRosterRow: true,
      separationDate: "9/27/2020",
      today: TODAY,
    });
    assert.equal(d.action, "Shred");
    assert.equal(d.foundLabel, "Yes");
  });

  it("found + separation within 5 years → Keep with the operator's 'Shred on sep+5y+1d' note", () => {
    // Mirrors the operator's manual sheet: sep 9/19/2021 → "Shred on 9/20/2026".
    const d = decideI9RetentionAction({
      found: true,
      hasRosterRow: true,
      separationDate: "9/19/2021",
      today: TODAY,
    });
    assert.equal(d.action, "Keep");
    assert.equal(d.note, "Shred on 9/20/2026");
  });

  it("boundary: retention end exactly today → still Keep (Shred only once passed)", () => {
    // sep + 5y === today (7/16/2021 + 5y = 7/16/2026)
    const d = decideI9RetentionAction({
      found: true,
      hasRosterRow: true,
      separationDate: "7/16/2021",
      today: TODAY,
    });
    assert.equal(d.action, "Keep");
    assert.equal(d.note, "Shred on 7/17/2026");
  });

  it("boundary: retention end yesterday → Shred", () => {
    const d = decideI9RetentionAction({
      found: true,
      hasRosterRow: true,
      separationDate: "7/15/2021",
      today: TODAY,
    });
    assert.equal(d.action, "Shred");
  });

  it("leap day separation rolls to Mar 1 in a non-leap target year", () => {
    const d = decideI9RetentionAction({
      found: true,
      hasRosterRow: true,
      separationDate: "2/29/2024",
      today: new Date(2026, 6, 16),
    });
    // 2/29/2024 + 5y → 3/1/2029; +1 day note = 3/2/2029
    assert.equal(d.action, "Keep");
    assert.equal(d.note, "Shred on 3/2/2029");
  });

  it("found but no roster row → blank action + review-manually note naming the EID", () => {
    const d = decideI9RetentionAction({
      found: true,
      hasRosterRow: false,
      emplId: "10458971",
      today: TODAY,
    });
    assert.equal(d.action, "");
    assert.match(d.note, /EID 10458971/);
    assert.match(d.note, /review manually/);
  });

  it("found, roster row but unparseable separation date → blank action + note", () => {
    const d = decideI9RetentionAction({
      found: true,
      hasRosterRow: true,
      separationDate: "",
      today: TODAY,
    });
    assert.equal(d.action, "");
    assert.match(d.note, /retention cannot be computed/);
  });

  it("ambiguous UCPath match → blank action, candidate count in the Found column", () => {
    const d = decideI9RetentionAction({
      found: true,
      ambiguous: true,
      ambiguousCandidateCount: 3,
      hasRosterRow: false,
      today: TODAY,
    });
    assert.equal(d.action, "");
    assert.equal(d.foundLabel, "Ambiguous in UCPath (3 candidates)");
    assert.match(d.note, /review manually/);
  });
});

describe("appendI9CheckTrackerRow", () => {
  it("creates file + sheet + bold header on first append; preserves PPS leading zeros as text", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "i9-tracker-"));
    t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "i9-check-tracker.xlsx");

    await appendI9CheckTrackerRow(path, baseRow({}));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const ws = wb.getWorksheet(I9_CHECK_SHEET_NAME);
    assert.ok(ws, "sheet exists");
    assert.equal(ws.getRow(1).getCell(1).value, "Employee Name");
    assert.equal(ws.getRow(1).font?.bold, true);
    assert.equal(ws.getRow(1).cellCount, I9_CHECK_TRACKER_COLUMNS.length);
    assert.equal(ws.getRow(2).getCell(1).value, "Vega, Omar");
    // Leading zeros preserved — stored as the string, column formatted as text.
    assert.equal(ws.getRow(2).getCell(2).value, "000039549");
    assert.equal(ws.getColumn(2).numFmt, "@");
  });

  it("appends to the SAME single sheet across calls (re-runs append again, never dedupe)", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "i9-tracker-"));
    t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "i9-check-tracker.xlsx");

    await appendI9CheckTrackerRow(path, baseRow({ employeeName: "One, Person" }));
    await appendI9CheckTrackerRow(path, baseRow({ employeeName: "Two, Person" }));
    await appendI9CheckTrackerRow(path, baseRow({ employeeName: "One, Person" })); // re-run

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    assert.equal(wb.worksheets.length, 1, "one sheet, never daily tabs");
    const ws = wb.getWorksheet(I9_CHECK_SHEET_NAME);
    assert.equal(ws?.actualRowCount, 4); // header + 3 appends
    assert.equal(ws?.getRow(4).getCell(1).value, "One, Person");
  });

  it("two concurrent appends both land (lock serializes them)", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "i9-tracker-"));
    t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "i9-check-tracker.xlsx");

    await Promise.all([
      appendI9CheckTrackerRow(path, baseRow({ employeeName: "A, Person" })),
      appendI9CheckTrackerRow(path, baseRow({ employeeName: "B, Person" })),
    ]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const ws = wb.getWorksheet(I9_CHECK_SHEET_NAME);
    const names = [ws?.getRow(2).getCell(1).value, ws?.getRow(3).getCell(1).value].sort();
    assert.deepEqual(names, ["A, Person", "B, Person"]);
    assert.equal(existsSync(`${path}.lock`), false, "lock released");
  });

  it("takes over a stale lock instead of hanging", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "i9-tracker-"));
    t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "i9-check-tracker.xlsx");
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, "99999");
    // Age the lock past the stale threshold.
    const past = (Date.now() - 120_000) / 1000;
    const { utimesSync } = await import("node:fs");
    utimesSync(lockPath, past, past);

    await appendI9CheckTrackerRow(path, baseRow({}));
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(lockPath), false);
  });
});
