import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  applyPersonLookupNameToOcrRecord,
  mergeOcrPersonNameParts,
  readOcrPersonNameParts,
  resolveOcrPersonDisplayName,
  splitOcrPersonName,
} from "../../../src/domain/identity/ocr-person-name.js";

describe("splitOcrPersonName", () => {
  it("splits Last, First into parts", () => {
    assert.deepEqual(splitOcrPersonName("Gozobu Sakef, Gida"), {
      firstName: "Gida",
      lastName: "Gozobu Sakef",
      display: "Gozobu Sakef, Gida",
    });
  });
});

describe("applyPersonLookupNameToOcrRecord", () => {
  it("patches EC employee first/last/name from resolvedName", () => {
    const rec: Record<string, unknown> = { employee: { name: "Gida Gozobu Sakef", employeeId: "10090313" } };
    applyPersonLookupNameToOcrRecord(rec, {
      searchName: "Gida Gozobu Sakef",
      resolvedName: "Gozobu Sakef, Gida",
    });
    const employee = rec.employee as Record<string, string>;
    assert.equal(employee.firstName, "Gida");
    assert.equal(employee.lastName, "Gozobu Sakef");
    assert.equal(employee.name, "Gozobu Sakef, Gida");
  });

  it("does NOT overwrite a present paper printedName but still fills first/last", () => {
    const rec: Record<string, unknown> = { printedName: "Gida Gozobu Sakef", employeeId: "10090313" };
    applyPersonLookupNameToOcrRecord(rec, {
      resolvedName: "Gozobu Sakef, Gida",
    });
    assert.equal(rec.firstName, "Gida");
    assert.equal(rec.lastName, "Gozobu Sakef");
    // printedName is the PAPER side of the verify name check — enrichment
    // must never clobber it, or the check compares the lookup to itself.
    assert.equal(rec.printedName, "Gida Gozobu Sakef");
  });

  it("still stamps printedName when it is blank", () => {
    const rec: Record<string, unknown> = { printedName: "   ", employeeId: "10090313" };
    applyPersonLookupNameToOcrRecord(rec, {
      resolvedName: "Gozobu Sakef, Gida",
    });
    assert.equal(rec.firstName, "Gida");
    assert.equal(rec.lastName, "Gozobu Sakef");
    assert.equal(rec.printedName, "Gozobu Sakef, Gida");
  });

  it("still stamps printedName when it is missing", () => {
    const rec: Record<string, unknown> = { printedName: null, employeeId: "10090313" };
    applyPersonLookupNameToOcrRecord(rec, {
      resolvedName: "Gozobu Sakef, Gida",
    });
    assert.equal(rec.printedName, "Gozobu Sakef, Gida");
  });

  it("returns the raw resolved name for callers to reuse", () => {
    const rec: Record<string, unknown> = { printedName: null };
    assert.equal(
      applyPersonLookupNameToOcrRecord(rec, { resolvedName: "Gozobu Sakef, Gida" }),
      "Gozobu Sakef, Gida",
    );
    assert.equal(
      applyPersonLookupNameToOcrRecord(rec, { searchName: "Gida Gozobu Sakef" }),
      "Gida Gozobu Sakef",
    );
    assert.equal(applyPersonLookupNameToOcrRecord(rec, undefined), undefined);
  });

  it("does not stamp an EID searchName into first/last/name when resolvedName is missing", () => {
    const rec: Record<string, unknown> = {
      employee: { firstName: "Aosamon", lastName: "Mesopu", name: "Mesopu, Aosamon", employeeId: "10090204" },
    };
    assert.equal(
      applyPersonLookupNameToOcrRecord(rec, { searchName: "10090204" }),
      undefined,
    );
    const employee = rec.employee as Record<string, string>;
    assert.equal(employee.firstName, "Aosamon");
    assert.equal(employee.lastName, "Mesopu");
    assert.equal(employee.name, "Mesopu, Aosamon");
  });
});

describe("mergeOcrPersonNameParts", () => {
  it("patching firstName on a fullName-only record preserves the split-derived lastName", () => {
    const merged = mergeOcrPersonNameParts(
      { fullName: "Gozobu Sakef, Gida" },
      { firstName: "Gidza" },
    );
    assert.deepEqual(merged, {
      firstName: "Gidza",
      lastName: "Gozobu Sakef",
      name: "Gozobu Sakef, Gidza",
    });
  });

  it("patching lastName keeps the current firstName and resolves the display name", () => {
    const merged = mergeOcrPersonNameParts(
      { firstName: "Gida", lastName: "Gozobu Sakef" },
      { lastName: "Gozobu" },
    );
    assert.deepEqual(merged, {
      firstName: "Gida",
      lastName: "Gozobu",
      name: "Gozobu, Gida",
    });
  });

  // OCR sometimes puts the EID in firstName/name. Clearing First Name must
  // NOT resurrect that stale fullName — otherwise the field looks uneditable
  // (select-all + Delete snaps the EID right back into the input).
  it("clearing firstName when fullName is the EID does not snap the EID back", () => {
    const merged = mergeOcrPersonNameParts(
      { firstName: "10090204", lastName: "", fullName: "10090204" },
      { firstName: "" },
    );
    assert.deepEqual(merged, {
      firstName: "",
      lastName: "",
      name: "",
    });
  });

  it("typing a first name alone does not keep a stale EID fullName as the display name", () => {
    const merged = mergeOcrPersonNameParts(
      { firstName: "10090204", lastName: "", fullName: "10090204" },
      { firstName: "Aosamon" },
    );
    assert.deepEqual(merged, {
      firstName: "Aosamon",
      lastName: "",
      name: "Aosamon",
    });
  });
});

describe("readOcrPersonNameParts", () => {
  it("falls back to splitting a legacy full name", () => {
    assert.deepEqual(
      readOcrPersonNameParts({ fullName: "Gozobu Sakef, Gida" }),
      {
        firstName: "Gida",
        lastName: "Gozobu Sakef",
        display: "Gozobu Sakef, Gida",
      },
    );
  });

  it("prefers explicit first/last fields", () => {
    assert.equal(
      resolveOcrPersonDisplayName({ firstName: "Gida", lastName: "Gozobu Sakef" }),
      "Gozobu Sakef, Gida",
    );
  });
});
