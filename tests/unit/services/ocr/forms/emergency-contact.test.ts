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

  it("coerces a STRING contact address into { street } instead of dropping the record (VL-003)", () => {
    // The vision LLM sometimes returns address as a one-line string rather than
    // the structured object. Pre-fix, the strict object schema rejected it and
    // per-page finalize() dropped the WHOLE record (operator saw fewer
    // approvable EC records than the PDF held). It must survive instead.
    const parsed = PermissiveRecordSchema.safeParse({
      sourcePage: 6,
      employee: { name: "Mandy Wu", employeeId: "10678901" },
      emergencyContact: {
        name: "Kelly Wu",
        relationship: "Sibling",
        address: "123 Main St, San Diego, CA 92122", // single string, not an object
        cellPhone: "(858) 555-0006",
      },
      documentType: "expected",
      originallyMissing: [],
    });
    assert.ok(
      parsed.success,
      `EC record with a STRING address must parse — got: ${JSON.stringify(!parsed.success && parsed.error.issues)}`,
    );
    // String coerced to { street }, so the contact has an address → not same-as-employee.
    assert.equal(parsed.data.emergencyContact.sameAddressAsEmployee, false);
    assert.equal(parsed.data.emergencyContact.address?.street, "123 Main St, San Diego, CA 92122");
  });

  it("coerces a STRING employee homeAddress into { street } (VL-003)", () => {
    const parsed = PermissiveRecordSchema.safeParse({
      sourcePage: 7,
      employee: { name: "Emily Sanchez", employeeId: "10789012", homeAddress: "456 Elm Ave, La Jolla, CA 92037" },
      emergencyContact: { name: "Pat Sanchez", relationship: "Parent" },
      documentType: "expected",
      originallyMissing: [],
    });
    assert.ok(
      parsed.success,
      `EC record with a STRING employee homeAddress must parse — got: ${JSON.stringify(!parsed.success && parsed.error.issues)}`,
    );
    assert.equal(parsed.data.employee.homeAddress?.street, "456 Elm Ave, La Jolla, CA 92037");
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

// ─── PermissiveRecordSchema.formKind enum (2026-06-06) ─────────────────────
// The EC schema now accepts "oath" and "unknown" so the EC OCR pass can classify
// pages that turned out to be oath forms or blank pages.

describe("PermissiveRecordSchema — formKind enum (EC run classifying non-EC pages)", () => {
  it("defaults formKind to 'emergency-contact' when omitted", () => {
    const parsed = PermissiveRecordSchema.safeParse({
      sourcePage: 1,
      employee: { name: "Alex Johnson", employeeId: "10123456" },
      emergencyContact: { name: "Pat Johnson", relationship: "Spouse", primary: true },
      notes: [],
      documentType: "expected",
      originallyMissing: [],
    });
    assert.ok(parsed.success, `parse should succeed: ${JSON.stringify(!parsed.success && parsed.error.issues)}`);
    assert.equal(parsed.data.formKind, "emergency-contact");
  });

  it("accepts formKind 'oath' (oath page inside an EC run)", () => {
    const parsed = PermissiveRecordSchema.safeParse({
      sourcePage: 2,
      formKind: "oath",
      employee: { name: null, employeeId: null },
      emergencyContact: { name: null, relationship: null, primary: true },
      notes: [],
      documentType: "expected",
      originallyMissing: [],
    });
    assert.ok(parsed.success, `oath formKind must be valid in EC schema: ${JSON.stringify(!parsed.success && parsed.error.issues)}`);
    assert.equal(parsed.data.formKind, "oath");
  });

  it("accepts formKind 'unknown' (blank page inside an EC run)", () => {
    const parsed = PermissiveRecordSchema.safeParse({
      sourcePage: 3,
      formKind: "unknown",
      employee: { name: null, employeeId: null },
      emergencyContact: { name: null, relationship: null, primary: true },
      notes: [],
      documentType: "unknown",
      originallyMissing: [],
    });
    assert.ok(parsed.success, `unknown formKind must be valid in EC schema: ${JSON.stringify(!parsed.success && parsed.error.issues)}`);
    assert.equal(parsed.data.formKind, "unknown");
  });

  // Regression (F13, 2026-06-07): the prompt tells the model to NULL EC-specific
  // fields (employee, emergencyContact) for non-EC pages. Those were non-nullable
  // objects, so a correctly classified oath/unknown page with them nulled was
  // schema-dropped → per-page.ts flipped it to success:false → data loss. They
  // are now `z.preprocess(v => v ?? {}, …)` so a `null` coerces to an empty
  // object the permissive sub-schema fills with defaults (downstream
  // `record.employee.X` reads stay null-safe).
  it("accepts null cross-form fields on a wrong-form page (oath/unknown inside an EC run)", () => {
    const parsed = PermissiveRecordSchema.safeParse({
      sourcePage: 4,
      formKind: "oath",
      employee: null,
      emergencyContact: null,
      notes: [],
      documentType: "expected",
      originallyMissing: [],
    });
    assert.ok(
      parsed.success,
      `wrong-form EC record with nulled employee/emergencyContact must parse — got: ${JSON.stringify(!parsed.success && parsed.error.issues)}`,
    );
    assert.equal(parsed.data.formKind, "oath");
    // null coerces to a defaulted object — downstream reads stay null-safe.
    assert.equal(parsed.data.employee.employeeId, "");
    assert.equal(parsed.data.employee.name, undefined);
    assert.equal(parsed.data.emergencyContact.name, undefined);
    // The EC sub-schema's blank-address transform still runs → defaults to true.
    assert.equal(parsed.data.emergencyContact.sameAddressAsEmployee, true);
  });
});

// ─── emergencyContactOcrFormSpec.approveTo.canFanOut ─────────────────────────
// An oath/unknown page classified inside an EC run must NOT be fanned out as an
// emergency-contact row.

describe("emergencyContactOcrFormSpec.approveTo.canFanOut", () => {
  const canFanOut = emergencyContactOcrFormSpec.approveTo!.canFanOut!;

  it("returns true for a properly classified EC record", () => {
    assert.equal(
      canFanOut({
        formKind: "emergency-contact",
        sourcePage: 1,
        employee: { name: "Alex Johnson", employeeId: "10123456" },
        emergencyContact: { name: "Pat Johnson", relationship: "Spouse", primary: true, sameAddressAsEmployee: true, address: null },
        notes: [],
        documentType: "expected",
        originallyMissing: [],
        matchState: "matched",
        selected: true,
        warnings: [],
      }),
      true,
    );
  });

  it("returns false for a record classified as 'oath' (oath page inside EC run)", () => {
    assert.equal(
      canFanOut({
        formKind: "oath",
        sourcePage: 2,
        employee: { name: null, employeeId: "" },
        emergencyContact: { name: null, relationship: null, primary: true, sameAddressAsEmployee: true, address: null },
        notes: [],
        documentType: "expected",
        originallyMissing: [],
        matchState: "extracted",
        selected: true,
        warnings: [],
      }),
      false,
      "oath-classified record must not fan out as an EC row",
    );
  });

  it("returns false for a record classified as 'unknown'", () => {
    assert.equal(
      canFanOut({
        formKind: "unknown",
        sourcePage: 3,
        employee: { name: null, employeeId: "" },
        emergencyContact: { name: null, relationship: null, primary: true, sameAddressAsEmployee: true, address: null },
        notes: [],
        documentType: "unknown",
        originallyMissing: [],
        matchState: "extracted",
        selected: true,
        warnings: [],
      }),
      false,
      "unknown-classified record must not fan out as an EC row",
    );
  });

  it("returns false for an EC record with a BLANK EID (F12 — guaranteed nav failure)", () => {
    assert.equal(
      canFanOut({
        formKind: "emergency-contact",
        sourcePage: 4,
        employee: { name: "Alex Johnson", employeeId: "" },
        emergencyContact: { name: "Pat Johnson", relationship: "Spouse", primary: true, sameAddressAsEmployee: true, address: null },
        notes: [],
        documentType: "expected",
        originallyMissing: [],
        matchState: "unresolved",
        selected: true,
        warnings: [],
      }),
      false,
      "an EC record with no employee EID must not fan out — the daemon navigates by EID",
    );
  });

  it("returns false for an EC record with a too-short EID", () => {
    assert.equal(
      canFanOut({
        formKind: "emergency-contact",
        sourcePage: 5,
        employee: { name: "Alex Johnson", employeeId: "123" },
        emergencyContact: { name: "Pat Johnson", relationship: "Spouse", primary: true, sameAddressAsEmployee: true, address: null },
        notes: [],
        documentType: "expected",
        originallyMissing: [],
        matchState: "matched",
        selected: true,
        warnings: [],
      }),
      false,
      "a sub-5-digit EID is not a valid UCPath nav key",
    );
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
