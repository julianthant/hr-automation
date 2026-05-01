import { test } from "node:test";
import assert from "node:assert";
import { FORM_SPECS, getFormSpec, listFormTypes } from "../../../../src/workflows/ocr/form-registry.js";

test("FORM_SPECS includes oath + emergency-contact", () => {
  assert.ok(FORM_SPECS.oath);
  assert.ok(FORM_SPECS["emergency-contact"]);
});

test("getFormSpec resolves known formType", () => {
  const oath = getFormSpec("oath");
  assert.ok(oath);
  assert.equal(oath.formType, "oath");
});

test("getFormSpec returns null for unknown", () => {
  assert.equal(getFormSpec("not-a-form"), null);
});

test("listFormTypes returns metadata for the run modal", () => {
  const list = listFormTypes();
  assert.equal(list.length, 2);
  const oath = list.find((f) => f.formType === "oath");
  assert.ok(oath);
  assert.equal(oath.label, "Oath signature");
  assert.equal(oath.rosterMode, "required");
});
