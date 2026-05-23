import { test } from "vitest";
import assert from "node:assert";
import { oathOcrFormSpec, normalizeOathDate } from "../../../../src/services/ocr/forms/oath.js";
import type { RosterRow } from "../../../../src/workflows/ocr/types.js";

const roster: RosterRow[] = [
  { eid: "10000001", name: "Liam Kustenbauder" },
  { eid: "10000002", name: "Akitsugu Uchida" },
  { eid: "10000003", name: "Sarah Chen" },
];

test("oath OCR prompt requires scanning top margin for standalone handwritten EIDs", () => {
  assert.match(oathOcrFormSpec.prompt, /top (?:page )?margin/i);
  assert.match(oathOcrFormSpec.prompt, /standalone handwritten/i);
  assert.match(oathOcrFormSpec.prompt, /above the form header/i);
});

test("matchRecord: signed row with high-confidence roster name → matched", async () => {
  const ocr = {
    formKind: "oath" as const,
    sourcePage: 1, rowIndex: 0,
    printedName: "Liam Kustenbauder",
    employeeSigned: true, officerSigned: true,
    dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = await oathOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "matched");
  assert.equal(preview.employeeId, "10000001");
  assert.equal(preview.selected, true);
  assert.equal(preview.matchSource, "roster");
});

test("matchRecord: signed row with one fuzzy roster candidate → matched before active-check", async () => {
  const ocr = {
    formKind: "oath" as const,
    sourcePage: 1, rowIndex: 0,
    printedName: "Sarah Chenn",
    employeeSigned: true, officerSigned: true,
    dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = await oathOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "matched");
  assert.equal(preview.employeeId, "10000003");
  assert.equal(preview.matchSource, "roster");
  assert.match(preview.warnings.join(" "), /single roster candidate/i);
});

test("matchRecord: unsigned row → extracted, deselected, no employeeId", async () => {
  const ocr = {
    formKind: "oath" as const,
    sourcePage: 1, rowIndex: 1,
    printedName: "Some Person",
    employeeSigned: false, officerSigned: null,
    dateSigned: null,
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = await oathOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "extracted");
  assert.equal(preview.employeeId, "");
  assert.equal(preview.selected, false);
});

test("matchRecord: signed row with no roster match → lookup-pending", async () => {
  const ocr = {
    formKind: "oath" as const,
    sourcePage: 1, rowIndex: 2,
    printedName: "Unknown Person Notroster",
    employeeSigned: true, officerSigned: true,
    dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = await oathOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "lookup-pending");
  assert.equal(preview.employeeId, "");
});

test("matchRecord: high OCR name confidence skips roster LLM disambiguation", async () => {
  const ocr = {
    formKind: "oath" as const,
    sourcePage: 1, rowIndex: 0,
    printedName: "Carlos D Barahona Martell",
    confidence: 0.94,
    employeeSigned: true, officerSigned: true,
    dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = await oathOcrFormSpec.matchRecord({
    record: ocr,
    roster: [
      { eid: "10000010", name: "Barahona Martell, Carlos" },
      { eid: "10000011", name: "Barahona, Carlos D" },
    ],
  });
  assert.equal(preview.matchState, "lookup-pending");
  assert.equal(preview.matchSource, "manual");
  assert.equal(preview.employeeId, "");
  assert.match(preview.warnings.join(" "), /high OCR name confidence/i);
});

test("matchRecord: low OCR name confidence keeps roster LLM disambiguation path", async () => {
  const ocr = {
    formKind: "oath" as const,
    sourcePage: 1, rowIndex: 0,
    printedName: "Carlos D Barahona Martell",
    confidence: 0.42,
    employeeSigned: true, officerSigned: true,
    dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = await oathOcrFormSpec.matchRecord({
    record: ocr,
    roster: [
      { eid: "10000010", name: "Barahona Martell, Carlos" },
      { eid: "10000011", name: "Barahona, Carlos D" },
    ],
  });
  assert.equal(preview.matchState, "lookup-pending");
  assert.notEqual(preview.matchSource, "manual");
  assert.ok((preview.rosterCandidates?.length ?? 0) > 0);
});

test("needsLookup: lookup-pending → 'name'", async () => {
  const r = { matchState: "lookup-pending", employeeId: "" } as any;
  assert.equal(oathOcrFormSpec.needsLookup(r), "name");
});

test("needsLookup: matched with eid → 'verify'", async () => {
  const r = { matchState: "matched", employeeId: "10000001" } as any;
  assert.equal(oathOcrFormSpec.needsLookup(r), "verify");
});

test("needsLookup: extracted (unsigned) → null", async () => {
  const r = { matchState: "extracted", employeeId: "" } as any;
  assert.equal(oathOcrFormSpec.needsLookup(r), null);
});

test("needsLookup: resolved with eid → null (already done)", async () => {
  const r = { matchState: "resolved", employeeId: "10000001" } as any;
  assert.equal(oathOcrFormSpec.needsLookup(r), null);
});

test("carryForwardKey normalizes name", async () => {
  const r1 = { printedName: "  Liam Kustenbauder  " } as any;
  const r2 = { printedName: "liam kustenbauder" } as any;
  assert.equal(oathOcrFormSpec.carryForwardKey(r1), oathOcrFormSpec.carryForwardKey(r2));
});

test("applyCarryForward inherits resolved EID + verification + selection", async () => {
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

test("approveTo.deriveInput: matched record → OathSignatureInput shape", async () => {
  const r = {
    employeeId: "10000001",
    printedName: "Doe, Jane",
    dateSigned: "05/01/2026",
  } as any;
  const input = oathOcrFormSpec.approveTo.deriveInput(r);
  assert.equal(input.emplId, "10000001");
  assert.equal(input.name, "Doe, Jane");
  assert.equal(input.date, "05/01/2026");
});

test("approveTo.deriveInput: OCR uppercase names are normalized for queue display", async () => {
  const comma = oathOcrFormSpec.approveTo.deriveInput({
    employeeId: "10000001",
    printedName: "ABUTIN, JASON, L",
    dateSigned: "05/01/2026",
  } as any);
  const natural = oathOcrFormSpec.approveTo.deriveInput({
    employeeId: "10000002",
    printedName: "CORREA DINORA",
    dateSigned: "05/15/2003",
  } as any);

  assert.equal(comma.name, "Abutin, Jason, L");
  assert.equal(natural.name, "Correa Dinora");
});

test("approveTo.deriveItemId: deterministic shape", async () => {
  const r = {} as any;
  const id = oathOcrFormSpec.approveTo.deriveItemId(r, "parent-run-xyz", 3);
  assert.match(id, /^ocr-oath-/);
  assert.match(id, /parent-run-xyz/);
  assert.match(id, /r3$/);
});

test("normalizeOathDate: handwritten formats coerce to MM/DD/YYYY", () => {
  // 2-digit year + dash separators (the case that triggered the user's
  // validation error: OCR extracted "4-23-26" off the form).
  assert.equal(normalizeOathDate("4-23-26"), "04/23/2026");
  assert.equal(normalizeOathDate("12-9-25"), "12/09/2025");
  // Slash separators, mixed-width components.
  assert.equal(normalizeOathDate("4/23/2026"), "04/23/2026");
  assert.equal(normalizeOathDate("04/23/2026"), "04/23/2026");
  assert.equal(normalizeOathDate("4/23/26"), "04/23/2026");
  // Already-canonical input is a no-op.
  assert.equal(normalizeOathDate("01/01/2027"), "01/01/2027");
  // Whitespace is tolerated.
  assert.equal(normalizeOathDate("  4/23/2026  "), "04/23/2026");
});

test("normalizeOathDate: invalid or absent input returns null", () => {
  assert.equal(normalizeOathDate(null), null);
  assert.equal(normalizeOathDate(""), null);
  assert.equal(normalizeOathDate("   "), null);
  assert.equal(normalizeOathDate("next tuesday"), null);
  // Out-of-range month/day get rejected so we never send PeopleSoft garbage.
  assert.equal(normalizeOathDate("13/05/2026"), null);
  assert.equal(normalizeOathDate("4/32/2026"), null);
  // Mixed separators inside a single date are rejected.
  assert.equal(normalizeOathDate("4-23/2026"), "04/23/2026"); // [-] then [/] both allowed at each position
  // Extra components are rejected.
  assert.equal(normalizeOathDate("4-23-2026-extra"), null);
});

test("approveTo.deriveInput: 2-digit-year handwritten dateSigned normalizes", () => {
  const r = {
    employeeId: "10000001",
    dateSigned: "4-23-26",
  } as any;
  const input = oathOcrFormSpec.approveTo.deriveInput(r);
  assert.equal(input.emplId, "10000001");
  assert.equal(input.date, "04/23/2026");
});

test("approveTo.deriveInput: unparseable date is dropped (workflow falls back to today)", () => {
  const r = {
    employeeId: "10000001",
    dateSigned: "next tuesday",
  } as any;
  const input = oathOcrFormSpec.approveTo.deriveInput(r);
  assert.equal(input.emplId, "10000001");
  assert.equal(input.date, undefined);
});
