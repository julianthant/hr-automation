import { test } from "node:test";
import assert from "node:assert";
import { applyCarryForward } from "../../../../src/workflows/ocr/carry-forward.js";
import { oathOcrFormSpec } from "../../../../src/workflows/oath-signature/ocr-form.js";
import type { AnyOcrFormSpec } from "../../../../src/workflows/ocr/types.js";

// Cast helpers: tests mix v1 ("resolved") and v2 ("lookup-pending") record
// shapes that have incompatible literal matchState types; the runtime behavior
// is correct — these casts keep TS happy without changing semantics.
const spec = oathOcrFormSpec as unknown as AnyOcrFormSpec;

const v1Records = [
  {
    sourcePage: 1, rowIndex: 0,
    printedName: "Liam Kustenbauder",
    employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
    employeeId: "10000001",
    matchState: "resolved" as const,
    matchSource: "eid-lookup" as const,
    selected: true,
    warnings: [],
    verification: {
      state: "verified" as const,
      hrStatus: "Active",
      department: "HDH",
      screenshotFilename: "x.png",
      checkedAt: "2026-05-01T00:00:00Z",
    },
  },
];

test("v2 record matching v1 by name inherits resolved fields", () => {
  const v2Records = [{
    sourcePage: 1, rowIndex: 0,
    printedName: "Liam Kustenbauder",
    employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
    employeeId: "",
    matchState: "lookup-pending" as const,
    selected: true,
    warnings: [],
  }];

  const result = applyCarryForward({ v2Records: v2Records as unknown[], v1Records: v1Records as unknown[], spec });
  const r0 = result[0] as Record<string, unknown>;
  assert.equal(r0.employeeId, "10000001");
  assert.equal(r0.matchState, "resolved");
});

test("v2 record with no v1 match treated as fresh", () => {
  const v2Records = [{
    sourcePage: 1, rowIndex: 0,
    printedName: "Brand New Person",
    employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
    employeeId: "",
    matchState: "lookup-pending" as const,
    selected: true,
    warnings: [],
  }];

  const result = applyCarryForward({ v2Records: v2Records as unknown[], v1Records: v1Records as unknown[], spec });
  const r0 = result[0] as Record<string, unknown>;
  assert.equal(r0.employeeId, "");
  assert.equal(r0.matchState, "lookup-pending");
});

test("v1 record with forceResearch=true is NOT carried forward", () => {
  const v1Forced = [{ ...v1Records[0], forceResearch: true }];
  const v2Records = [{
    sourcePage: 1, rowIndex: 0,
    printedName: "Liam Kustenbauder",
    employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
    employeeId: "",
    matchState: "lookup-pending" as const,
    selected: true,
    warnings: [],
  }];

  const result = applyCarryForward({ v2Records: v2Records as unknown[], v1Records: v1Forced as unknown[], spec });
  const r0 = result[0] as Record<string, unknown>;
  assert.equal(r0.employeeId, "");
  assert.equal(r0.matchState, "lookup-pending");
});

test("Levenshtein ≤ 2 still matches (single-character difference)", () => {
  const v2Records = [{
    sourcePage: 1, rowIndex: 0,
    printedName: "Liam Kustenbouder", // typo: a→o
    employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
    employeeId: "",
    matchState: "lookup-pending" as const,
    selected: true,
    warnings: [],
  }];

  const result = applyCarryForward({ v2Records: v2Records as unknown[], v1Records: v1Records as unknown[], spec });
  const r0 = result[0] as Record<string, unknown>;
  assert.equal(r0.employeeId, "10000001");
});
