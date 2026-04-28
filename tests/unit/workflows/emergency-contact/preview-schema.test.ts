import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PreviewRecordSchema,
  PrepareRowDataSchema,
  OcrOutputSchema,
} from "../../../../src/workflows/emergency-contact/preview-schema.js";

describe("PreviewRecordSchema", () => {
  it("accepts a valid extracted record", () => {
    const r = PreviewRecordSchema.parse({
      sourcePage: 1,
      employee: { name: "Test", employeeId: "12345" },
      emergencyContact: {
        name: "C",
        relationship: "Mother",
        primary: true,
        sameAddressAsEmployee: true,
        address: null,
        cellPhone: null,
        homePhone: null,
        workPhone: null,
      },
      notes: [],
      matchState: "extracted",
      selected: true,
      warnings: [],
    });
    assert.equal(r.matchState, "extracted");
    assert.equal(r.selected, true);
  });

  it("accepts an empty employeeId (filled later by orchestrator)", () => {
    const r = PreviewRecordSchema.parse({
      sourcePage: 1,
      employee: { name: "Test", employeeId: "" },
      emergencyContact: {
        name: "C",
        relationship: "Mother",
        primary: true,
        sameAddressAsEmployee: true,
        address: null,
        cellPhone: null,
        homePhone: null,
        workPhone: null,
      },
      notes: [],
      matchState: "lookup-pending",
      selected: true,
      warnings: ["needs eid-lookup"],
    });
    assert.equal(r.employee.employeeId, "");
  });

  it("rejects an invalid matchState", () => {
    assert.throws(() =>
      PreviewRecordSchema.parse({
        sourcePage: 1,
        employee: { name: "Test", employeeId: "12345" },
        emergencyContact: {
          name: "C",
          relationship: "Mother",
          primary: true,
          sameAddressAsEmployee: true,
          address: null,
          cellPhone: null,
          homePhone: null,
          workPhone: null,
        },
        notes: [],
        matchState: "bogus",
        selected: true,
        warnings: [],
      } as never),
    );
  });
});

describe("PrepareRowDataSchema", () => {
  it("requires mode === 'prepare'", () => {
    assert.throws(() =>
      PrepareRowDataSchema.parse({
        mode: "item",
        pdfPath: "x",
        pdfOriginalName: "x.pdf",
        rosterMode: "existing",
        rosterPath: "r.xlsx",
        records: [],
      } as never),
    );
  });
});

describe("OcrOutputSchema", () => {
  it("accepts a record array with permissive employeeId", () => {
    const out = OcrOutputSchema.parse([
      {
        sourcePage: 1,
        employee: { name: "Test", employeeId: "" },
        emergencyContact: {
          name: "C",
          relationship: "Mother",
          primary: true,
          sameAddressAsEmployee: true,
          address: null,
          cellPhone: null,
          homePhone: null,
          workPhone: null,
        },
        notes: [],
      },
    ]);
    assert.equal(out.length, 1);
  });

  it("still enforces same-address-when-null transform on the contact", () => {
    const out = OcrOutputSchema.parse([
      {
        sourcePage: 1,
        employee: { name: "Test", employeeId: "" },
        emergencyContact: {
          name: "C",
          relationship: "Mother",
          primary: true,
          sameAddressAsEmployee: false,
          address: null,
          cellPhone: null,
          homePhone: null,
          workPhone: null,
        },
        notes: [],
      },
    ]);
    assert.equal(out[0].emergencyContact.sameAddressAsEmployee, true);
  });
});
