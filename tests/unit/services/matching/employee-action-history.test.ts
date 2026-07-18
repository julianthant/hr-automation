/**
 * Employee Action History loader + I-9 cross-ref — pure match helpers + a
 * fixture xlsx built in-memory so the live Action History file is not required.
 */
import { describe, it, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";

import {
  __resetActionHistoryCacheForTests,
  applyActionHistoryToI9Record,
  crossRefI9Record,
  loadEmployeeActionHistory,
  lookupActionHistoryRowByEmplId,
  lookupActionHistoryRowByPpsId,
  middleNamesCompatible,
  normalizePpsIdKey,
  pickActionHistoryRow,
  resolveI9ActionHistoryPath,
  splitPersonNameParts,
  type ActionHistoryIndex,
  type ActionHistoryRow,
} from "../../../../src/services/matching/employee-action-history.js";
import { PATHS } from "../../../../src/config.js";

function row(over: Partial<ActionHistoryRow>): ActionHistoryRow {
  return {
    name: "Doe, Jane",
    ucpathEmplId: "10458971",
    ppsEid: "000039549",
    jobStartDate: "4/17/2018",
    jobEndDate: "8/6/2021",
    jobActionCode: "TER",
    jobAction: "Termination",
    ...over,
  };
}

function emptyIndex(over: Partial<ActionHistoryIndex> = {}): ActionHistoryIndex {
  return {
    sourcePath: "/tmp/fixture.xlsx",
    byEmplId: new Map(),
    byNormalizedName: new Map(),
    byLastFirst: new Map(),
    byPpsId: new Map(),
    ...over,
  };
}

describe("pickActionHistoryRow", () => {
  it("prefers the latest Termination by Job End Date", () => {
    const picked = pickActionHistoryRow([
      row({ jobEndDate: "1/1/2020", jobActionCode: "TER" }),
      row({ jobEndDate: "8/6/2021", jobActionCode: "TER" }),
      row({ jobEndDate: "9/1/2022", jobActionCode: "PAY", jobAction: "Pay Rate Change" }),
    ]);
    assert.equal(picked?.jobEndDate, "8/6/2021");
  });

  it("falls back to the latest row when no TER exists", () => {
    const picked = pickActionHistoryRow([
      row({ jobEndDate: "1/1/2020", jobActionCode: "HIR", jobAction: "Hire" }),
      row({ jobEndDate: "3/3/2021", jobActionCode: "PAY", jobAction: "Pay Rate Change" }),
    ]);
    assert.equal(picked?.jobEndDate, "3/3/2021");
  });
});

describe("crossRefI9Record", () => {
  const index = emptyIndex({
    byEmplId: new Map([
      ["10458971", [row({ name: "Vega, Omar", ucpathEmplId: "10458971", ppsEid: "000039549" })]],
    ]),
    byNormalizedName: new Map([
      ["vega, omar", [row({ name: "Vega, Omar", ucpathEmplId: "10458971", ppsEid: "000039549" })]],
    ]),
    byLastFirst: new Map([
      ["vega|omar", [row({ name: "Vega, Omar", ucpathEmplId: "10458971", ppsEid: "000039549" })]],
    ]),
    byPpsId: new Map([
      ["39549", [row({ name: "Vega, Omar", ucpathEmplId: "10458971", ppsEid: "000039549" })]],
    ]),
  });

  it("matches by live Empl ID and strips leading zeros from PPS", () => {
    const xref = crossRefI9Record({ matchedEmplId: "10458971", name: "Other" }, index);
    assert.equal(xref.ppsEid, "39549");
    assert.equal(xref.ppsEidPadded, "000039549");
    assert.equal(xref.rosterEmplId, "10458971");
    assert.equal(xref.i9SeparationDate, "8/6/2021");
  });

  it("falls back to normalized name when Empl ID is absent", () => {
    const xref = crossRefI9Record({ name: "Vega, Omar" }, index);
    assert.equal(xref.ppsEid, "39549");
    assert.equal(xref.rosterEmplId, "10458971");
  });

  it("returns empty when neither Empl ID nor name matches", () => {
    assert.deepEqual(crossRefI9Record({ name: "Nobody, Here" }, index), {});
  });

  it("applyActionHistoryToI9Record stamps the enrichment keys", () => {
    const rec: Record<string, unknown> = {};
    applyActionHistoryToI9Record(rec, {
      ppsEid: "39549",
      ppsEidPadded: "000039549",
      rosterEmplId: "10458971",
      i9SeparationDate: "8/6/2021",
    });
    assert.equal(rec.ppsEid, "39549");
    assert.equal(rec.ppsEidPadded, "000039549");
    assert.equal(rec.rosterEmplId, "10458971");
    assert.equal(rec.i9SeparationDate, "8/6/2021");
  });
});

describe("lookupActionHistoryRowByEmplId", () => {
  const index = emptyIndex({
    byEmplId: new Map([
      [
        "10458971",
        [
          row({ jobEndDate: "1/1/2020", jobActionCode: "TER" }),
          row({ jobEndDate: "8/6/2021", jobActionCode: "TER" }),
        ],
      ],
    ]),
    byNormalizedName: new Map([
      ["vega, omar", [row({ name: "Vega, Omar", ucpathEmplId: "99999999" })]],
    ]),
  });

  it("picks the retention row for a known Empl ID", () => {
    const picked = lookupActionHistoryRowByEmplId("10458971", index);
    assert.equal(picked?.jobEndDate, "8/6/2021");
  });

  it("returns undefined for an unknown or blank Empl ID — NO name fallback", () => {
    assert.equal(lookupActionHistoryRowByEmplId("10000000", index), undefined);
    assert.equal(lookupActionHistoryRowByEmplId("  ", index), undefined);
  });
});

describe("lookupActionHistoryRowByPpsId / normalizePpsIdKey", () => {
  const index = emptyIndex({
    byPpsId: new Map([
      [
        "39549",
        [
          row({ ppsEid: "000039549", jobEndDate: "1/1/2020", jobActionCode: "TER" }),
          row({ ppsEid: "000039549", jobEndDate: "8/6/2021", jobActionCode: "TER" }),
        ],
      ],
    ]),
  });

  it("normalizePpsIdKey strips leading zeros and non-digits", () => {
    assert.equal(normalizePpsIdKey("000039549"), "39549");
    assert.equal(normalizePpsIdKey("39549"), "39549");
    assert.equal(normalizePpsIdKey("  000044696  "), "44696");
    assert.equal(normalizePpsIdKey(""), null);
    assert.equal(normalizePpsIdKey("abc"), null);
  });

  it("matches a padded or 5-digit OCR PPS seed", () => {
    assert.equal(lookupActionHistoryRowByPpsId("000039549", index)?.jobEndDate, "8/6/2021");
    assert.equal(lookupActionHistoryRowByPpsId("39549", index)?.jobEndDate, "8/6/2021");
  });

  it("returns undefined for an unknown PPS", () => {
    assert.equal(lookupActionHistoryRowByPpsId("99999", index), undefined);
  });
});

describe("resolveI9ActionHistoryPath / loadEmployeeActionHistory", () => {
  test("default path points at data/rosters Employee Action History", () => {
    assert.match(PATHS.i9ActionHistoryPath, /Employee Action History Report/);
    assert.match(PATHS.i9ActionHistoryPath, /data[/\\]rosters/);
  });

  test("missing override path fails loud", () => {
    assert.throws(
      () => resolveI9ActionHistoryPath("/tmp/definitely-missing-action-history-xyz.xlsx"),
      /I-9 Action History roster missing/,
    );
  });

  test("loadEmployeeActionHistory parses a minimal xlsx fixture", async () => {
    __resetActionHistoryCacheForTests();
    const dir = mkdtempSync(join(tmpdir(), "action-history-"));
    const path = join(dir, "history.xlsx");
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Report Page");
      ws.addRow([
        "Employee Name Current",
        "Employee ID",
        "Employee PPS ID Current",
        "Job Start Date",
        "Job End Date",
        "Job Action Code",
        "Job Action",
      ]);
      ws.addRow([
        "Vega, Omar",
        "10458971",
        "000039549",
        new Date(2018, 3, 17),
        new Date(2021, 7, 6),
        "TER",
        "Termination",
      ]);
      const buf = await wb.xlsx.writeBuffer();
      writeFileSync(path, Buffer.from(buf));

      const index = await loadEmployeeActionHistory(path);
      assert.equal(index.byEmplId.get("10458971")?.length, 1);
      assert.equal(index.byPpsId.get("39549")?.length, 1, "indexes Employee PPS ID Current");
      const xref = crossRefI9Record({ matchedEmplId: "10458971" }, index);
      assert.equal(xref.ppsEid, "39549");
      assert.equal(xref.i9SeparationDate, "8/6/2021");
      assert.equal(lookupActionHistoryRowByPpsId("39549", index)?.ucpathEmplId, "10458971");
    } finally {
      __resetActionHistoryCacheForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The two-pass contract, and the ONE systematic difference between the sources:
 * an I-9 Section 1 has a Middle INITIAL box, the Action History carries a full
 * middle name. An exact-string name index missed every person who has one
 * (live 2026-07-16: "Abramson, Michelle M" ≠ "Abramson, Michelle Meili").
 */
describe("crossRefI9Record — name pass tolerates I-9 middle initials", () => {
  const meili = row({
    name: "Abramson, Michelle Meili",
    ucpathEmplId: "10403707",
    ppsEid: "000044696",
  });
  const index = emptyIndex({
    byEmplId: new Map([["10403707", [meili]]]),
    byNormalizedName: new Map([["abramson, michelle meili", [meili]]]),
    byLastFirst: new Map([["abramson|michelle", [meili]]]),
    byPpsId: new Map([["44696", [meili]]]),
  });

  it("matches a middle INITIAL against the roster's full middle name", () => {
    assert.equal(crossRefI9Record({ name: "Abramson, Michelle M" }, index).ppsEid, "44696");
  });

  it("matches when the I-9 recorded no middle name at all", () => {
    assert.equal(crossRefI9Record({ name: "Abramson, Michelle" }, index).ppsEid, "44696");
  });

  it("matches from lastName/firstName/middleInitial parts (no comma'd name)", () => {
    const xref = crossRefI9Record(
      { lastName: "Abramson", firstName: "Michelle", middleInitial: "M" },
      index,
    );
    assert.equal(xref.ppsEid, "44696");
  });

  it("does NOT match a CONFLICTING middle initial — that is a different person", () => {
    assert.deepEqual(crossRefI9Record({ name: "Abramson, Michelle R" }, index), {});
  });

  // Never coin-flip a PPS ID onto a real HR record.
  it("REFUSES to guess when last+first is ambiguous across two Empl IDs", () => {
    const a = row({ name: "Sanchez, Maria", ucpathEmplId: "10000001", ppsEid: "000000011" });
    const b = row({ name: "Sanchez, Maria", ucpathEmplId: "10000002", ppsEid: "000000022" });
    const ambiguous = emptyIndex({
      byLastFirst: new Map([["sanchez|maria", [a, b]]]),
    });
    assert.deepEqual(crossRefI9Record({ name: "Sanchez, Maria J" }, ambiguous), {});
  });

  it("still resolves an ambiguous last+first when the middle initial separates them", () => {
    const a = row({ name: "Sanchez, Maria Jose", ucpathEmplId: "10000001", ppsEid: "000000011" });
    const b = row({ name: "Sanchez, Maria Elena", ucpathEmplId: "10000002", ppsEid: "000000022" });
    const separable = emptyIndex({
      byLastFirst: new Map([["sanchez|maria", [a, b]]]),
    });
    assert.equal(crossRefI9Record({ name: "Sanchez, Maria E" }, separable).ppsEid, "22");
  });

  it("a multi-word surname stays whole", () => {
    const parts = splitPersonNameParts("Torres Perez, Edgar I");
    assert.deepEqual(parts, { last: "torres perez", first: "edgar", middle: "i" });
  });

  it("middleNamesCompatible: absent/initial/full rules", () => {
    assert.equal(middleNamesCompatible("", "meili"), true, "absent is compatible");
    assert.equal(middleNamesCompatible("m", "meili"), true, "initial matches full");
    assert.equal(middleNamesCompatible("meili", "m"), true, "full matches initial");
    assert.equal(middleNamesCompatible("r", "meili"), false, "wrong initial");
    assert.equal(middleNamesCompatible("marie", "meili"), false, "two different middles");
  });
});
