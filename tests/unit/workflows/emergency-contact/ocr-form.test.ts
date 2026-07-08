import { test } from "vitest";
import assert from "node:assert";
import { emergencyContactOcrFormSpec } from "../../../../src/services/ocr/forms/emergency-contact.js";
import type { RosterRow } from "../../../../src/workflows/ocr/types.js";

const roster: RosterRow[] = [
  { eid: "10001234", name: "Maria Garcia", street: "123 Main St", city: "San Diego", state: "CA", zip: "92101" },
  { eid: "10005678", name: "James Wong" },
];

test("matchRecord: form-EID present + roster same name → matched, skip lookup", async () => {
  const ocr = {
    formKind: "emergency-contact" as const,
    sourcePage: 1,
    employee: { name: "Maria Garcia", employeeId: "10001234" },
    emergencyContact: { name: "Sara Garcia", relationship: "Sister", primary: true, sameAddressAsEmployee: true, address: null, cellPhone: "(555) 123-4567" },
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = await emergencyContactOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "matched");
  assert.equal(preview.matchSource, "form");
  assert.equal(preview.employee.employeeId, "10001234");
  assert.equal(preview.rosterNameTrust, "same");
  assert.equal(preview.selected, true);
  assert.equal(emergencyContactOcrFormSpec.needsLookup(preview), null);
});

test("matchRecord: form-EID + similar roster name → matched, skip lookup", async () => {
  const ocr = {
    formKind: "emergency-contact" as const,
    sourcePage: 1,
    employee: { name: "Maria Garica", employeeId: "10001234" },
    emergencyContact: { name: "Sara Garcia", relationship: "Sister", primary: true, sameAddressAsEmployee: true, address: null, cellPhone: "(555) 123-4567" },
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = await emergencyContactOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "matched");
  assert.equal(preview.rosterNameTrust, "similar");
  assert.equal(emergencyContactOcrFormSpec.needsLookup(preview), null);
});

test("matchRecord: form-EID + different roster name → matched from roster, skip lookup", async () => {
  const ocr = {
    formKind: "emergency-contact" as const,
    sourcePage: 1,
    employee: { name: "Wrong Person", employeeId: "10001234" },
    emergencyContact: { name: "Sara Garcia", relationship: "Sister", primary: true, sameAddressAsEmployee: true, address: null, cellPhone: "(555) 123-4567" },
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = await emergencyContactOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "matched");
  assert.equal(preview.matchSource, "form");
  assert.equal(preview.employee.name, "Wrong Person");
  assert.equal(preview.employee.employeeId, "10001234");
  assert.equal(preview.rosterNameTrust, "similar");
  assert.equal(emergencyContactOcrFormSpec.needsLookup(preview), null);
});

test("matchRecord: form-EID present + blank OCR name → matched, name from roster, skip lookup", async () => {
  const ocr = {
    formKind: "emergency-contact" as const,
    sourcePage: 1,
    employee: { name: "", employeeId: "10001234" },
    emergencyContact: { name: "Sara Garcia", relationship: "Sister", primary: true, sameAddressAsEmployee: true, address: null, cellPhone: "(555) 123-4567" },
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = await emergencyContactOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "matched");
  assert.equal(preview.matchSource, "form");
  assert.equal(preview.employee.name, "Maria Garcia");
  assert.equal(preview.employee.employeeId, "10001234");
  assert.equal(preview.rosterNameTrust, "same");
  assert.equal(emergencyContactOcrFormSpec.needsLookup(preview), null);
  assert.ok(preview.warnings.some((w) => w.includes("taken from roster")));
});

test("matchRecord: no form-EID, high roster name match → matched (roster), skip lookup", async () => {
  const ocr = {
    formKind: "emergency-contact" as const,
    sourcePage: 2,
    employee: { name: "Maria Garcia", employeeId: "" },
    emergencyContact: { name: "Sara Garcia", relationship: "Sister", primary: true, sameAddressAsEmployee: true, address: null, cellPhone: "(555) 123-4567" },
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = await emergencyContactOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "matched");
  assert.equal(preview.matchSource, "roster");
  assert.equal(preview.employee.employeeId, "10001234");
  assert.equal(preview.rosterNameTrust, "same");
  assert.equal(emergencyContactOcrFormSpec.needsLookup(preview), null);
});

test("matchRecord: no form-EID, one fuzzy roster candidate below ROSTER_AUTO_ACCEPT → lookup-pending", async () => {
  // "James Womg" vs "James Wong" → Levenshtein-1 → score 0.7 < 0.85 threshold
  const ocr = {
    formKind: "emergency-contact" as const,
    sourcePage: 2,
    employee: { name: "James Womg", employeeId: "" },
    emergencyContact: { name: "Sara Wong", relationship: "Sister", primary: true, sameAddressAsEmployee: true, address: null, cellPhone: "(555) 123-4567" },
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = await emergencyContactOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "lookup-pending");
  assert.equal(preview.employee.employeeId, "");
});

test("matchRecord: no form-EID, multiple fuzzy roster candidates → LLM disambiguation can pick", async () => {
  // Two-token search name required for token-set matching. Single-token names
  // ("Maria") no longer qualify after the duplicate-token-collapse fix.
  const ocr = {
    formKind: "emergency-contact" as const,
    sourcePage: 2,
    employee: { name: "Maria Garcia", employeeId: "" },
    emergencyContact: { name: "Sara Garcia", relationship: "Sister", primary: true, sameAddressAsEmployee: true, address: null, cellPhone: "(555) 123-4567" },
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = await emergencyContactOcrFormSpec.matchRecord({
    record: ocr,
    roster: [
      { eid: "10001234", name: "Maria Garcia Rodriguez" },
      { eid: "10009999", name: "Maria Garcia Hernandez" },
    ],
  });
  assert.equal(preview.matchState, "lookup-pending");
  assert.equal(preview.employee.employeeId, "");
  assert.equal(preview.rosterCandidates?.length, 2);

  const patched = emergencyContactOcrFormSpec.applyDisambiguation({
    record: preview,
    result: { eid: "10009999", confidence: 0.8 },
  });
  assert.equal(patched.matchState, "matched");
  assert.equal(patched.matchSource, "llm");
  assert.equal(patched.employee.employeeId, "10009999");
});

test("matchRecord: no form-EID, no roster match → lookup-pending", async () => {
  const ocr = {
    formKind: "emergency-contact" as const,
    sourcePage: 3,
    employee: { name: "Unknown Person", employeeId: "" },
    emergencyContact: { name: "Other Person", relationship: "Friend", primary: true, sameAddressAsEmployee: true, address: null, cellPhone: "(555) 999-0000" },
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = await emergencyContactOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "lookup-pending");
  assert.equal(preview.employee.employeeId, "");
});

test("needsLookup: matched-via-form with roster trust → null", async () => {
  const r = { matchState: "matched", matchSource: "form", rosterNameTrust: "same", employee: { employeeId: "10001234" } } as any;
  assert.equal(emergencyContactOcrFormSpec.needsLookup(r), null);
});

test("needsLookup: matched-via-roster with roster trust → null", async () => {
  const r = { matchState: "matched", matchSource: "roster", rosterNameTrust: "similar", employee: { employeeId: "10001234" } } as any;
  assert.equal(emergencyContactOcrFormSpec.needsLookup(r), null);
});

test("needsLookup: matched-via-roster without trust → null (roster-backed identity)", async () => {
  const r = { matchState: "matched", matchSource: "roster", employee: { employeeId: "10001234" } } as any;
  assert.equal(emergencyContactOcrFormSpec.needsLookup(r), null);
});

test("needsLookup: matched-via-llm roster candidate → null", async () => {
  const r = {
    matchState: "matched",
    matchSource: "llm",
    employee: { employeeId: "10001234" },
    rosterCandidates: [{ eid: "10001234", name: "Maria Garcia", score: 0.9 }],
  } as any;
  assert.equal(emergencyContactOcrFormSpec.needsLookup(r), null);
});

test("needsLookup: matched without roster source → 'verify'", async () => {
  const r = { matchState: "matched", matchSource: "llm", employee: { employeeId: "10001234" } } as any;
  assert.equal(emergencyContactOcrFormSpec.needsLookup(r), "verify");
});

test("needsLookup: lookup-pending → 'name'", async () => {
  const r = { matchState: "lookup-pending", employee: { employeeId: "" } } as any;
  assert.equal(emergencyContactOcrFormSpec.needsLookup(r), "name");
});

test("needsLookup: matched + verification already present → null", async () => {
  const r = { matchState: "matched", employee: { employeeId: "10001234" }, verification: { state: "verified" } } as any;
  assert.equal(emergencyContactOcrFormSpec.needsLookup(r), null);
});

test("carryForwardKey uses employee name normalized", async () => {
  const r1 = { employee: { name: "  Maria GARCIA  " } } as any;
  const r2 = { employee: { name: "maria garcia" } } as any;
  assert.equal(emergencyContactOcrFormSpec.carryForwardKey(r1), emergencyContactOcrFormSpec.carryForwardKey(r2));
});

test("approveTo.deriveInput returns RecordSchema-compatible shape", async () => {
  const approveTo = emergencyContactOcrFormSpec.approveTo;
  assert.ok(approveTo);
  const r = {
    sourcePage: 1,
    employee: { name: "Maria Garcia", employeeId: "10001234" },
    emergencyContact: { name: "Sara Garcia", relationship: "Sister", primary: true, sameAddressAsEmployee: true, cellPhone: "(555) 123-4567" },
    notes: [],
  } as any;
  const input = approveTo.deriveInput(r, { sessionId: "sess", runId: "run1" });
  assert.equal(input.employee.employeeId, "10001234");
  assert.equal(input.emergencyContact.name, "Sara Garcia");
});

test("approveTo.deriveItemId: deterministic", async () => {
  const approveTo = emergencyContactOcrFormSpec.approveTo;
  assert.ok(approveTo);
  const r = { sourcePage: 5, employee: { employeeId: "10001234" } } as any;
  const id = approveTo.deriveItemId(r, "parent-xyz", 2);
  assert.match(id, /^ocr-ec-/);
  assert.match(id, /parent-xyz/);
  assert.match(id, /r2$/);
});
