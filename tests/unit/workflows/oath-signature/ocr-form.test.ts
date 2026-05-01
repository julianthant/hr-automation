import { test } from "node:test";
import assert from "node:assert";
import { oathOcrFormSpec } from "../../../../src/workflows/oath-signature/ocr-form.js";
import type { RosterRow } from "../../../../src/workflows/ocr/types.js";

const roster: RosterRow[] = [
  { eid: "10000001", name: "Liam Kustenbauder" },
  { eid: "10000002", name: "Akitsugu Uchida" },
  { eid: "10000003", name: "Sarah Chen" },
];

test("matchRecord: signed row with high-confidence roster name → matched", () => {
  const ocr = {
    sourcePage: 1, rowIndex: 0,
    printedName: "Liam Kustenbauder",
    employeeSigned: true, officerSigned: true,
    dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = oathOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "matched");
  assert.equal(preview.employeeId, "10000001");
  assert.equal(preview.selected, true);
  assert.equal(preview.matchSource, "roster");
});

test("matchRecord: unsigned row → extracted, deselected, no employeeId", () => {
  const ocr = {
    sourcePage: 1, rowIndex: 1,
    printedName: "Some Person",
    employeeSigned: false, officerSigned: null,
    dateSigned: null,
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = oathOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "extracted");
  assert.equal(preview.employeeId, "");
  assert.equal(preview.selected, false);
});

test("matchRecord: signed row with no roster match → lookup-pending", () => {
  const ocr = {
    sourcePage: 1, rowIndex: 2,
    printedName: "Unknown Person Notroster",
    employeeSigned: true, officerSigned: true,
    dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = oathOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "lookup-pending");
  assert.equal(preview.employeeId, "");
});

test("needsLookup: lookup-pending → 'name'", () => {
  const r = { matchState: "lookup-pending", employeeId: "" } as any;
  assert.equal(oathOcrFormSpec.needsLookup(r), "name");
});

test("needsLookup: matched with eid → 'verify'", () => {
  const r = { matchState: "matched", employeeId: "10000001" } as any;
  assert.equal(oathOcrFormSpec.needsLookup(r), "verify");
});

test("needsLookup: extracted (unsigned) → null", () => {
  const r = { matchState: "extracted", employeeId: "" } as any;
  assert.equal(oathOcrFormSpec.needsLookup(r), null);
});

test("needsLookup: resolved with eid → null (already done)", () => {
  const r = { matchState: "resolved", employeeId: "10000001" } as any;
  assert.equal(oathOcrFormSpec.needsLookup(r), null);
});

test("carryForwardKey normalizes name", () => {
  const r1 = { printedName: "  Liam Kustenbauder  " } as any;
  const r2 = { printedName: "liam kustenbauder" } as any;
  assert.equal(oathOcrFormSpec.carryForwardKey(r1), oathOcrFormSpec.carryForwardKey(r2));
});

test("applyCarryForward inherits resolved EID + verification + selection", () => {
  const v1 = {
    employeeId: "10000001",
    matchState: "resolved" as const,
    matchSource: "eid-lookup" as const,
    selected: true,
    verification: { state: "verified", hrStatus: "Active", department: "HDH", screenshotFilename: "x.png", checkedAt: "2026-05-01T00:00:00Z" },
    forceResearch: false,
  } as any;
  const v2 = {
    employeeId: "",
    matchState: "lookup-pending" as const,
    selected: true,
  } as any;
  const merged = oathOcrFormSpec.applyCarryForward({ v2, v1 });
  assert.equal(merged.employeeId, "10000001");
  assert.equal(merged.matchState, "resolved");
  assert.equal(merged.matchSource, "eid-lookup");
  assert.deepEqual(merged.verification?.state, "verified");
});

test("approveTo.deriveInput: matched record → OathSignatureInput shape", () => {
  const r = {
    employeeId: "10000001",
    dateSigned: "05/01/2026",
  } as any;
  const input = oathOcrFormSpec.approveTo.deriveInput(r);
  assert.equal(input.emplId, "10000001");
  assert.equal(input.date, "05/01/2026");
});

test("approveTo.deriveItemId: deterministic shape", () => {
  const r = {} as any;
  const id = oathOcrFormSpec.approveTo.deriveItemId(r, "parent-run-xyz", 3);
  assert.match(id, /^ocr-oath-/);
  assert.match(id, /parent-run-xyz/);
  assert.match(id, /r3$/);
});
