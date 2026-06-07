import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { emergencyContactOcrFormSpec, PermissiveRecordSchema } from "../../../../../src/services/ocr/forms/emergency-contact.js";
import type { RosterRow } from "../../../../../src/services/matching/match.js";

function makeRecord(name: string) {
  return {
    formKind: "emergency-contact" as const,
    sourcePage: 1,
    employee: { name, employeeId: "" },
    emergencyContact: {
      name: "Jane Contact",
      relationship: "Spouse",
      primary: true as const,
      sameAddressAsEmployee: true as const,
      address: null,
    },
    notes: [],
    documentType: "expected" as const,
    originallyMissing: [],
  };
}

function rosterRow(name: string, eid: string): RosterRow {
  return { eid, name };
}

// ─── PermissiveRecordSchema (OCR-pass decoupling) ───────────────────────────
//
// Regression guard for the "zero records extracted from clearly-filled EC form"
// bug: the strict EmergencyContactSchema required sameAddressAsEmployee: boolean
// (no default), but the vision LLM never emits this computed field → safeParse
// failed → per-page finalize() dropped every EC record silently.  The fix
// decouples the OCR-pass schema (PermissiveRecordSchema) from the strict
// downstream schema so:
//   1. sameAddressAsEmployee is optional in the OCR pass.
//   2. name / relationship are nullable so partially-filled forms still extract.
//   3. matchRecord + deriveInput still compile and produce valid downstream
//      EmergencyContactRecord shapes.

describe("PermissiveRecordSchema — OCR-pass permissive EC schema", () => {
  it("parses a fully-filled EC record", () => {
    const parsed = PermissiveRecordSchema.safeParse({
      sourcePage: 1,
      employee: { name: "Alex Johnson", employeeId: "10123456" },
      emergencyContact: {
        name: "Pat Johnson",
        relationship: "Spouse",
        primary: true,
        sameAddressAsEmployee: false,
        address: { street: "456 Oak Ave", city: "La Jolla", state: "CA", zip: "92037" },
        cellPhone: "(858) 555-0001",
      },
      notes: [],
      documentType: "expected",
      originallyMissing: [],
    });
    assert.ok(parsed.success, `parse should succeed, got: ${JSON.stringify(!parsed.success && parsed.error.issues)}`);
    assert.equal(parsed.data.employee.employeeId, "10123456");
    assert.equal(parsed.data.emergencyContact.name, "Pat Johnson");
    assert.equal(parsed.data.emergencyContact.relationship, "Spouse");
    assert.equal(parsed.data.emergencyContact.sameAddressAsEmployee, false);
  });

  it("parses when sameAddressAsEmployee is OMITTED (the root-cause field) — defaults to true when no address", () => {
    // This was the failing case: the vision LLM never emits sameAddressAsEmployee
    // (it is computed, never on the paper).  The strict schema required it →
    // safeParse failed → per-page finalize() dropped the whole page silently.
    const parsed = PermissiveRecordSchema.safeParse({
      sourcePage: 2,
      employee: { name: "Jordan Lee", employeeId: "10234567" },
      emergencyContact: {
        // sameAddressAsEmployee intentionally omitted — LLM never sets this field
        name: "Robin Lee",
        relationship: "Parent",
        cellPhone: "(619) 555-0002",
      },
      documentType: "expected",
      originallyMissing: [],
    });
    assert.ok(
      parsed.success,
      `EC record with omitted sameAddressAsEmployee must parse — got: ${JSON.stringify(!parsed.success && parsed.error.issues)}`,
    );
    // No address on contact → blank-address rule forces same-as-employee = true
    assert.equal(parsed.data.emergencyContact.sameAddressAsEmployee, true);
    assert.equal(parsed.data.emergencyContact.address, null);
  });

  it("parses when relationship is null/omitted (partially-filled form)", () => {
    // Partially-filled forms must still extract so the operator can complete them
    // in the review pane — the previous strict schema required relationship: z.string().min(1).
    const parsed = PermissiveRecordSchema.safeParse({
      sourcePage: 3,
      employee: { name: "Sam Rivera", employeeId: "10345678" },
      emergencyContact: {
        name: "Chris Rivera",
        relationship: null, // blank on the paper
        cellPhone: "(760) 555-0003",
      },
      documentType: "expected",
      originallyMissing: ["emergencyContact.relationship"],
    });
    assert.ok(
      parsed.success,
      `EC record with null relationship must parse — got: ${JSON.stringify(!parsed.success && parsed.error.issues)}`,
    );
    assert.equal(parsed.data.emergencyContact.relationship, null);
  });

  it("parses when contact name is null (partially-filled form)", () => {
    const parsed = PermissiveRecordSchema.safeParse({
      sourcePage: 4,
      employee: { name: "Casey Kim", employeeId: "10456789" },
      emergencyContact: {
        name: null, // blank on the paper
        relationship: "Friend",
      },
      documentType: "expected",
      originallyMissing: ["emergencyContact.name"],
    });
    assert.ok(
      parsed.success,
      `EC record with null contact name must parse — got: ${JSON.stringify(!parsed.success && parsed.error.issues)}`,
    );
    assert.equal(parsed.data.emergencyContact.name, null);
  });

  it("infers sameAddressAsEmployee=false when a contact address is provided and sameAddressAsEmployee is omitted", () => {
    const parsed = PermissiveRecordSchema.safeParse({
      sourcePage: 5,
      employee: { name: "Taylor Nguyen", employeeId: "10567890" },
      emergencyContact: {
        name: "Morgan Nguyen",
        relationship: "Sibling",
        // sameAddressAsEmployee omitted — has an address, so should become false
        address: { street: "789 Pine Rd", city: "Chula Vista", state: "CA", zip: "91910" },
      },
      documentType: "expected",
      originallyMissing: [],
    });
    assert.ok(parsed.success, `parse should succeed, got: ${JSON.stringify(!parsed.success && parsed.error.issues)}`);
    // Address present → same-as-employee = false
    assert.equal(parsed.data.emergencyContact.sameAddressAsEmployee, false);
    assert.ok(parsed.data.emergencyContact.address != null, "address should be present");
  });

  it("approveTo.deriveInput: produces an EmergencyContactRecord-compatible shape from a permissive record", () => {
    // Verify matchRecord + deriveInput compile and produce the downstream shape.
    // The cast `as EmergencyContactRecord` is intentional — strict re-parse happens
    // at the EC daemon boundary; this is the OCR-review-to-approve bridge.
    const approveTo = emergencyContactOcrFormSpec.approveTo;
    assert.ok(approveTo, "approveTo must be defined");
    const input = approveTo.deriveInput({
      sourcePage: 1,
      formKind: "emergency-contact",
      employee: { name: "Alex Johnson", employeeId: "10123456" },
      emergencyContact: {
        name: "Pat Johnson",
        relationship: "Spouse",
        primary: true,
        sameAddressAsEmployee: true,
        address: null,
        cellPhone: "(858) 555-0001",
      },
      notes: [],
      documentType: "expected",
      originallyMissing: [],
      matchState: "matched",
      matchSource: "form",
      matchConfidence: 1.0,
      selected: true,
      warnings: [],
    });
    assert.equal(input.employee.employeeId, "10123456");
    assert.equal(input.emergencyContact.name, "Pat Johnson");
  });
});

describe("emergencyContactOcrFormSpec.matchRecord auto-accept floor", () => {
  it("auto-accepts exact single candidate (score 1.0 ≥ ROSTER_AUTO_ACCEPT)", async () => {
    const result = await emergencyContactOcrFormSpec.matchRecord({
      record: makeRecord("John Doe"),
      roster: [rosterRow("John Doe", "10000001")],
    });
    assert.equal(result.matchState, "matched");
    assert.equal(result.employee.employeeId, "10000001");
  });

  it("auto-accepts token-set single candidate (score 0.9 ≥ ROSTER_AUTO_ACCEPT)", async () => {
    // "John Michael Doe" vs "John Doe" — token-set match, score 0.9
    const result = await emergencyContactOcrFormSpec.matchRecord({
      record: makeRecord("John Michael Doe"),
      roster: [rosterRow("John Doe", "10000002")],
    });
    assert.equal(result.matchState, "matched");
    assert.equal(result.employee.employeeId, "10000002");
  });

  it("does NOT auto-accept single fuzzy candidate below ROSTER_AUTO_ACCEPT (score 0.7)", async () => {
    // "John Smyth" vs "John Smith" — Levenshtein-1, score 0.7 < 0.85
    const result = await emergencyContactOcrFormSpec.matchRecord({
      record: makeRecord("John Smyth"),
      roster: [rosterRow("John Smith", "10000003")],
    });
    assert.equal(result.matchState, "lookup-pending");
    assert.equal(result.employee.employeeId, "");
  });
});
