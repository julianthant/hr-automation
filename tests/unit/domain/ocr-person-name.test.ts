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
    assert.deepEqual(splitOcrPersonName("Garcia Solis, Gema"), {
      firstName: "Gema",
      lastName: "Garcia Solis",
      display: "Garcia Solis, Gema",
    });
  });
});

describe("applyPersonLookupNameToOcrRecord", () => {
  it("patches EC employee first/last/name from resolvedName", () => {
    const rec: Record<string, unknown> = { employee: { name: "Gema Garcia Solis", employeeId: "10883754" } };
    applyPersonLookupNameToOcrRecord(rec, {
      searchName: "Gema Garcia Solis",
      resolvedName: "Garcia Solis, Gema",
    });
    const employee = rec.employee as Record<string, string>;
    assert.equal(employee.firstName, "Gema");
    assert.equal(employee.lastName, "Garcia Solis");
    assert.equal(employee.name, "Garcia Solis, Gema");
  });

  it("does NOT overwrite a present paper printedName but still fills first/last", () => {
    const rec: Record<string, unknown> = { printedName: "Gema Garcia Solis", employeeId: "10883754" };
    applyPersonLookupNameToOcrRecord(rec, {
      resolvedName: "Garcia Solis, Gema",
    });
    assert.equal(rec.firstName, "Gema");
    assert.equal(rec.lastName, "Garcia Solis");
    // printedName is the PAPER side of the verify name check — enrichment
    // must never clobber it, or the check compares the lookup to itself.
    assert.equal(rec.printedName, "Gema Garcia Solis");
  });

  it("still stamps printedName when it is blank", () => {
    const rec: Record<string, unknown> = { printedName: "   ", employeeId: "10883754" };
    applyPersonLookupNameToOcrRecord(rec, {
      resolvedName: "Garcia Solis, Gema",
    });
    assert.equal(rec.firstName, "Gema");
    assert.equal(rec.lastName, "Garcia Solis");
    assert.equal(rec.printedName, "Garcia Solis, Gema");
  });

  it("still stamps printedName when it is missing", () => {
    const rec: Record<string, unknown> = { printedName: null, employeeId: "10883754" };
    applyPersonLookupNameToOcrRecord(rec, {
      resolvedName: "Garcia Solis, Gema",
    });
    assert.equal(rec.printedName, "Garcia Solis, Gema");
  });

  it("returns the raw resolved name for callers to reuse", () => {
    const rec: Record<string, unknown> = { printedName: null };
    assert.equal(
      applyPersonLookupNameToOcrRecord(rec, { resolvedName: "Garcia Solis, Gema" }),
      "Garcia Solis, Gema",
    );
    assert.equal(
      applyPersonLookupNameToOcrRecord(rec, { searchName: "Gema Garcia Solis" }),
      "Gema Garcia Solis",
    );
    assert.equal(applyPersonLookupNameToOcrRecord(rec, undefined), undefined);
  });

  it("does not stamp an EID searchName into first/last/name when resolvedName is missing", () => {
    const rec: Record<string, unknown> = {
      employee: { firstName: "Alondra", lastName: "Magana", name: "Magana, Alondra", employeeId: "10778080" },
    };
    assert.equal(
      applyPersonLookupNameToOcrRecord(rec, { searchName: "10778080" }),
      undefined,
    );
    const employee = rec.employee as Record<string, string>;
    assert.equal(employee.firstName, "Alondra");
    assert.equal(employee.lastName, "Magana");
    assert.equal(employee.name, "Magana, Alondra");
  });
});

describe("mergeOcrPersonNameParts", () => {
  it("patching firstName on a fullName-only record preserves the split-derived lastName", () => {
    const merged = mergeOcrPersonNameParts(
      { fullName: "Garcia Solis, Gema" },
      { firstName: "Gemma" },
    );
    assert.deepEqual(merged, {
      firstName: "Gemma",
      lastName: "Garcia Solis",
      name: "Garcia Solis, Gemma",
    });
  });

  it("patching lastName keeps the current firstName and resolves the display name", () => {
    const merged = mergeOcrPersonNameParts(
      { firstName: "Gema", lastName: "Garcia Solis" },
      { lastName: "Garcia" },
    );
    assert.deepEqual(merged, {
      firstName: "Gema",
      lastName: "Garcia",
      name: "Garcia, Gema",
    });
  });

  // OCR sometimes puts the EID in firstName/name. Clearing First Name must
  // NOT resurrect that stale fullName — otherwise the field looks uneditable
  // (select-all + Delete snaps the EID right back into the input).
  it("clearing firstName when fullName is the EID does not snap the EID back", () => {
    const merged = mergeOcrPersonNameParts(
      { firstName: "10778080", lastName: "", fullName: "10778080" },
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
      { firstName: "10778080", lastName: "", fullName: "10778080" },
      { firstName: "Alondra" },
    );
    assert.deepEqual(merged, {
      firstName: "Alondra",
      lastName: "",
      name: "Alondra",
    });
  });
});

describe("readOcrPersonNameParts", () => {
  it("falls back to splitting a legacy full name", () => {
    assert.deepEqual(
      readOcrPersonNameParts({ fullName: "Garcia Solis, Gema" }),
      {
        firstName: "Gema",
        lastName: "Garcia Solis",
        display: "Garcia Solis, Gema",
      },
    );
  });

  it("prefers explicit first/last fields", () => {
    assert.equal(
      resolveOcrPersonDisplayName({ firstName: "Gema", lastName: "Garcia Solis" }),
      "Garcia Solis, Gema",
    );
  });
});
