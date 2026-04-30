import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MatchStateSchema,
  OathOcrOutputSchema,
  OathPreviewRecordSchema,
  OathPrepareRowDataSchema,
  OathRosterOcrRecordSchema,
} from "../../../../src/workflows/oath-signature/preview-schema.js";

describe("OathRosterOcrRecordSchema", () => {
  it("accepts a minimal signed row with a printed name", () => {
    const r = OathRosterOcrRecordSchema.parse({
      sourcePage: 1,
      rowIndex: 0,
      printedName: "Jane Doe",
      employeeSigned: true,
    });
    assert.equal(r.printedName, "Jane Doe");
    assert.equal(r.employeeSigned, true);
    assert.equal(r.dateSigned, null);
    assert.deepEqual(r.notes, []);
  });

  it("accepts unsigned rows (we still capture them for completeness)", () => {
    const r = OathRosterOcrRecordSchema.parse({
      sourcePage: 2,
      rowIndex: 5,
      printedName: "John Q. Public",
      employeeSigned: false,
    });
    assert.equal(r.employeeSigned, false);
  });

  it("normalizes dateSigned: trims and accepts MM/DD/YYYY-style strings as-is", () => {
    const r = OathRosterOcrRecordSchema.parse({
      sourcePage: 1,
      rowIndex: 1,
      printedName: "Alice",
      employeeSigned: true,
      dateSigned: "  04/27/2026  ",
    });
    assert.equal(r.dateSigned, "04/27/2026");
  });

  it("treats missing/empty dateSigned as null", () => {
    const r = OathRosterOcrRecordSchema.parse({
      sourcePage: 1,
      rowIndex: 0,
      printedName: "Bob",
      employeeSigned: true,
      dateSigned: "",
    });
    assert.equal(r.dateSigned, null);
  });

  it("rejects an empty printedName", () => {
    const result = OathRosterOcrRecordSchema.safeParse({
      sourcePage: 1,
      rowIndex: 0,
      printedName: "",
      employeeSigned: true,
    });
    assert.equal(result.success, false);
  });

  it("rejects a non-positive sourcePage", () => {
    assert.equal(
      OathRosterOcrRecordSchema.safeParse({
        sourcePage: 0,
        rowIndex: 0,
        printedName: "x",
        employeeSigned: false,
      }).success,
      false,
    );
    assert.equal(
      OathRosterOcrRecordSchema.safeParse({
        sourcePage: -1,
        rowIndex: 0,
        printedName: "x",
        employeeSigned: false,
      }).success,
      false,
    );
  });

  it("rejects a negative rowIndex", () => {
    assert.equal(
      OathRosterOcrRecordSchema.safeParse({
        sourcePage: 1,
        rowIndex: -1,
        printedName: "x",
        employeeSigned: false,
      }).success,
      false,
    );
  });
});

describe("OathOcrOutputSchema", () => {
  it("is an array of records", () => {
    const arr = OathOcrOutputSchema.parse([
      { sourcePage: 1, rowIndex: 0, printedName: "A", employeeSigned: true },
      { sourcePage: 1, rowIndex: 1, printedName: "B", employeeSigned: false },
    ]);
    assert.equal(arr.length, 2);
  });

  it("accepts an empty array (a paper roster with no detected signatures is valid input — match phase will report 0 approvable)", () => {
    const arr = OathOcrOutputSchema.parse([]);
    assert.equal(arr.length, 0);
  });
});

describe("MatchStateSchema", () => {
  it("accepts the six declared states", () => {
    for (const s of [
      "extracted",
      "matched",
      "lookup-pending",
      "lookup-running",
      "resolved",
      "unresolved",
    ]) {
      assert.equal(MatchStateSchema.parse(s), s);
    }
  });

  it("rejects an undeclared state", () => {
    assert.equal(MatchStateSchema.safeParse("approved").success, false);
  });
});

describe("OathPreviewRecordSchema", () => {
  it("accepts a matched-with-EID row with all extras populated", () => {
    const r = OathPreviewRecordSchema.parse({
      sourcePage: 1,
      rowIndex: 0,
      printedName: "Jane Doe",
      employeeSigned: true,
      dateSigned: "04/27/2026",
      employeeId: "10873611",
      matchState: "matched",
      matchSource: "roster",
      matchConfidence: 0.95,
      rosterCandidates: [{ eid: "10873611", name: "Doe, Jane", score: 0.95 }],
      selected: true,
      warnings: [],
    });
    assert.equal(r.employeeId, "10873611");
    assert.equal(r.matchState, "matched");
  });

  it("accepts a lookup-pending row with no EID and roster candidates", () => {
    const r = OathPreviewRecordSchema.parse({
      sourcePage: 1,
      rowIndex: 2,
      printedName: "Unknown Person",
      employeeSigned: true,
      employeeId: "",
      matchState: "lookup-pending",
      rosterCandidates: [],
      selected: true,
      warnings: ["No roster match"],
    });
    assert.equal(r.matchState, "lookup-pending");
    assert.equal(r.employeeId, "");
  });

  it("requires `selected` and `warnings` even on resolved rows", () => {
    const without = OathPreviewRecordSchema.safeParse({
      sourcePage: 1,
      rowIndex: 0,
      printedName: "Y",
      employeeSigned: true,
      employeeId: "10000000",
      matchState: "resolved",
    });
    assert.equal(without.success, false);
  });

  it("matchConfidence is bounded to [0, 1]", () => {
    const over = OathPreviewRecordSchema.safeParse({
      sourcePage: 1,
      rowIndex: 0,
      printedName: "Y",
      employeeSigned: true,
      employeeId: "1",
      matchState: "matched",
      matchConfidence: 1.5,
      selected: true,
      warnings: [],
    });
    assert.equal(over.success, false);
  });
});

describe("OathPrepareRowDataSchema", () => {
  it("accepts a minimal prep row with an empty records list", () => {
    const data = OathPrepareRowDataSchema.parse({
      mode: "prepare",
      pdfPath: "/tmp/foo.pdf",
      pdfOriginalName: "foo.pdf",
      rosterPath: "roster.xlsx",
      records: [],
    });
    assert.equal(data.mode, "prepare");
  });

  it("accepts a fully-populated prep row with ocr metadata", () => {
    const data = OathPrepareRowDataSchema.parse({
      mode: "prepare",
      pdfPath: "/tmp/x.pdf",
      pdfOriginalName: "x.pdf",
      rosterPath: "r.xlsx",
      records: [
        {
          sourcePage: 1,
          rowIndex: 0,
          printedName: "Jane",
          employeeSigned: true,
          employeeId: "10000000",
          matchState: "matched",
          matchSource: "roster",
          matchConfidence: 1.0,
          selected: true,
          warnings: [],
        },
      ],
      ocrProvider: "gemini",
      ocrAttempts: 2,
      ocrCached: false,
    });
    assert.equal(data.records.length, 1);
    assert.equal(data.ocrProvider, "gemini");
  });

  it("rejects a row whose mode is not 'prepare'", () => {
    const result = OathPrepareRowDataSchema.safeParse({
      mode: "live",
      pdfPath: "/tmp/x.pdf",
      pdfOriginalName: "x.pdf",
      rosterPath: "r.xlsx",
      records: [],
    });
    assert.equal(result.success, false);
  });
});
