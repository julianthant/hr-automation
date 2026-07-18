import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  describeOcrRecords,
  summarizeOcrRecordCount,
} from "../../../../src/services/ocr/per-page-pool.js";

describe("summarizeOcrRecordCount", () => {
  it("reports 0 records for empty or nullish input", () => {
    assert.equal(summarizeOcrRecordCount([]), "0 records");
    assert.equal(summarizeOcrRecordCount(null), "0 records");
    assert.equal(summarizeOcrRecordCount(undefined), "0 records");
  });

  it("pluralizes on the record count", () => {
    assert.equal(summarizeOcrRecordCount([{ formKind: "oath" }]), "1 record");
    assert.equal(summarizeOcrRecordCount([{}, {}, {}]), "3 records");
  });

  it("counts a bare object response as a single record", () => {
    assert.equal(summarizeOcrRecordCount({ formKind: "verify", printedName: "Solo" }), "1 record");
  });
});

describe("describeOcrRecords", () => {
  it("returns no lines for an empty response", () => {
    assert.deepEqual(describeOcrRecords([]), []);
    assert.deepEqual(describeOcrRecords(null), []);
  });

  it("describes an oath record as `<kind> · <name> · <marks>`", () => {
    assert.deepEqual(describeOcrRecords([{ formKind: "oath", printedName: "Nadia Goiset", employeeId: "10012345", employeeSigned: true }]), [
      "oath · Nadia Goiset · eid ✓ · signed ✓",
    ]);
  });

  it("marks a false boolean as a real read (✗), never as illegible", () => {
    // `employeeSigned: false` is the model ANSWERING "was it signed?" — the
    // fail-safe unsigned state, not a failure to read the page.
    assert.deepEqual(describeOcrRecords([{ formKind: "oath", printedName: "Mia Tran", employeeSigned: false }]), [
      "oath · Mia Tran · signed ✗",
    ]);
  });

  it("reads an EC record's name from the nested employee.name field (F9)", () => {
    // Realistic EC shape: the employee name lives at employee.name, not at the
    // top level. Previously this logged as `emergency-contact: —`.
    const json = [
      {
        formKind: "emergency-contact",
        employee: { name: "Nadia Goiset", employeeId: "10012345" },
        emergencyContact: { name: "Robin Goiset", relationship: "Spouse" },
      },
    ];
    assert.deepEqual(describeOcrRecords(json), [
      "emergency-contact · Nadia Goiset · eid ✓ · contact ✓",
    ]);
  });

  it("falls back to emergencyContact.name then employee.employeeId for a name-blank EC record", () => {
    // No employee.name (blank on paper) → fall to the contact name.
    assert.deepEqual(
      describeOcrRecords([
        { formKind: "emergency-contact", employee: { name: null, employeeId: "10099887" }, emergencyContact: { name: "Robin Goiset" } },
      ]),
      ["emergency-contact · Robin Goiset · eid ✓ · contact ✓"],
    );
    // Neither name present → fall to the nested EID.
    assert.deepEqual(
      describeOcrRecords([
        { formKind: "emergency-contact", employee: { name: null, employeeId: "10099887" }, emergencyContact: { name: null } },
      ]),
      ["emergency-contact · 10099887 · eid ✓ · contact —"],
    );
  });

  it("emits one line per record", () => {
    const json = [
      { formKind: "oath", printedName: "Nadia, K" },
      { formKind: "oath", printedName: "Vincent Provenzano" },
    ];
    assert.deepEqual(describeOcrRecords(json), ["oath · Nadia, K", "oath · Vincent Provenzano"]);
  });

  it("falls back to employeeId, then a dash, when printedName is absent", () => {
    assert.deepEqual(describeOcrRecords([{ formKind: "oath", printedName: "  ", employeeId: "10012345" }]), [
      "oath · 10012345 · eid ✓",
    ]);
    assert.deepEqual(describeOcrRecords([{ formKind: "oath" }]), ["oath · —"]);
  });

  it("drops the kind prefix when it is missing, and dashes non-object members", () => {
    assert.deepEqual(describeOcrRecords([{ printedName: "Mia Tran" }]), ["Mia Tran"]);
    assert.deepEqual(describeOcrRecords(["nope", 7]), ["—", "—"]);
  });

  it("caps the detail lines at 6 and counts the rest as `+N more records`", () => {
    const json = Array.from({ length: 8 }, (_, i) => ({ formKind: "oath", printedName: `P${i}` }));
    assert.deepEqual(describeOcrRecords(json), [
      "oath · P0",
      "oath · P1",
      "oath · P2",
      "oath · P3",
      "oath · P4",
      "oath · P5",
      "+2 more records",
    ]);
  });

  it("wraps a bare object response as a single record", () => {
    assert.deepEqual(describeOcrRecords({ formKind: "verify", printedName: "Solo" }), ["verify · Solo"]);
  });

  describe("i9 records", () => {
    // The i9 schema carries every field on every record, so a Section 1 record
    // holds `section2Name: null` and vice versa. Each record must only be
    // marked on the fields its own kind is responsible for.
    const section1 = {
      formKind: "i9",
      lastName: "Walters",
      firstName: "Kimi",
      middleInitial: null,
      dateOfBirth: "04/01/1998",
      ssn: "123-45-6789",
      illegible: [],
      originallyMissing: [],
      section2Name: null,
      section2DocNumber: null,
      section2HireDate: null,
    };

    it("labels a Section 1 page `i9 §1` and composes its split name", () => {
      assert.deepEqual(describeOcrRecords([section1]), ["i9 §1 · Walters, Kimi · ssn ✓ · dob ✓"]);
    });

    it("does not mark a Section 1 record on the section2 fields it never owned", () => {
      const line = describeOcrRecords([section1])[0];
      assert.ok(!line.includes("s2 "), `expected no section2 marks, got: ${line}`);
      assert.ok(!line.includes("hired"), `expected no hire mark, got: ${line}`);
    });

    it("marks an illegible field ✗ rather than reading as clean", () => {
      // The whole i9 trust model rests on this: a null the model FLAGGED is an
      // admission it could not read, and must not look like a blank field.
      assert.deepEqual(
        describeOcrRecords([{ ...section1, ssn: null, illegible: ["ssn"] }]),
        ["i9 §1 · Walters, Kimi · ssn ✗ illegible · dob ✓"],
      );
    });

    it("distinguishes a blank field (∅) from an illegible one (✗)", () => {
      assert.deepEqual(
        describeOcrRecords([{ ...section1, ssn: null, originallyMissing: ["ssn"] }]),
        ["i9 §1 · Walters, Kimi · ssn ∅ blank · dob ✓"],
      );
    });

    it("surfaces illegible NAME fields, which have no mark of their own", () => {
      assert.deepEqual(
        describeOcrRecords([{ ...section1, lastName: null, illegible: ["lastName"] }]),
        ["i9 §1 · Kimi · ssn ✓ · dob ✓ · illegible: lastName"],
      );
    });

    it("labels a Section 2 sheet `i9 §2` with its own uniform fields", () => {
      // The sheet is the trust oracle — it must not read as a filler page.
      assert.deepEqual(
        describeOcrRecords([
          {
            formKind: "i9 section 2",
            lastName: "Walters",
            firstName: "Kimi",
            ssn: "123-45-6789",
            hireDate: "04/17/2018",
            illegible: [],
            originallyMissing: [],
          },
        ]),
        ["i9 §2 · Walters, Kimi · name ✓ · ssn ✓ · hired ✓"],
      );
    });

    it("labels a LEGACY section2Name-bearing unknown page `i9 §2` (historical rows)", () => {
      assert.deepEqual(
        describeOcrRecords([
          {
            formKind: "unknown",
            lastName: null,
            ssn: null,
            illegible: [],
            originallyMissing: [],
            section2Name: "Walters, Kimi",
          },
        ]),
        ["i9 §2 · Walters, Kimi · name — · ssn —"],
      );
    });

    it("keeps a genuinely unknown filler page as `unknown`", () => {
      assert.deepEqual(
        describeOcrRecords([{ formKind: "unknown", section2Name: null, illegible: [] }]),
        ["unknown · —"],
      );
    });
  });
});
