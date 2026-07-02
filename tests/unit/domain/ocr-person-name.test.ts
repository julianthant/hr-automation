import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  applyPersonLookupNameToOcrRecord,
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

  it("patches oath printedName and first/last from resolvedName", () => {
    const rec: Record<string, unknown> = { printedName: "Gema Garcia Solis", employeeId: "10883754" };
    applyPersonLookupNameToOcrRecord(rec, {
      resolvedName: "Garcia Solis, Gema",
    });
    assert.equal(rec.firstName, "Gema");
    assert.equal(rec.lastName, "Garcia Solis");
    assert.equal(rec.printedName, "Garcia Solis, Gema");
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
