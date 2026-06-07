import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { summarizeOcrResponse } from "../../../../src/services/ocr/per-page-pool.js";

describe("summarizeOcrResponse", () => {
  it("reports 0 records for empty or nullish input", () => {
    assert.equal(summarizeOcrResponse([]), "0 records");
    assert.equal(summarizeOcrResponse(null), "0 records");
    assert.equal(summarizeOcrResponse(undefined), "0 records");
  });

  it("summarizes a single record as `<count> · <formKind>: <name>`", () => {
    const json = [{ formKind: "emergency-contact", printedName: "Nadia Goiset", employeeId: null }];
    assert.equal(summarizeOcrResponse(json), "1 record · emergency-contact: Nadia Goiset");
  });

  it("joins multiple records with a middle dot and pluralizes the count", () => {
    const json = [
      { formKind: "oath", printedName: "Nadia, K" },
      { formKind: "oath", printedName: "Vincent Provenzano" },
    ];
    assert.equal(
      summarizeOcrResponse(json),
      "2 records · oath: Nadia, K · oath: Vincent Provenzano",
    );
  });

  it("falls back to employeeId, then a dash, when printedName is absent", () => {
    assert.equal(
      summarizeOcrResponse([{ formKind: "oath", printedName: "  ", employeeId: "10012345" }]),
      "1 record · oath: 10012345",
    );
    assert.equal(summarizeOcrResponse([{ formKind: "oath" }]), "1 record · oath: —");
  });

  it("drops formKind prefix when it is missing, and dashes non-object members", () => {
    assert.equal(summarizeOcrResponse([{ printedName: "Mia Tran" }]), "1 record · Mia Tran");
    assert.equal(summarizeOcrResponse(["nope", 7]), "2 records · — · —");
  });

  it("caps the shown records at 4 and counts the rest as `+N more`", () => {
    const json = Array.from({ length: 6 }, (_, i) => ({ formKind: "oath", printedName: `P${i}` }));
    assert.equal(
      summarizeOcrResponse(json),
      "6 records · oath: P0 · oath: P1 · oath: P2 · oath: P3 · +2 more",
    );
  });

  it("wraps a bare object response as a single record", () => {
    assert.equal(
      summarizeOcrResponse({ formKind: "verify", printedName: "Solo" }),
      "1 record · verify: Solo",
    );
  });
});
