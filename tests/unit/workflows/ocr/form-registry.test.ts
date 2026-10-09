import { test } from "vitest";
import assert from "node:assert";
import { FORM_SPECS, getFormSpec, listFormTypes } from "../../../../src/workflows/ocr/form-registry.js";

test("FORM_SPECS includes oath + emergency-contact + onbase-emergency-contact + verify + i9", () => {
  assert.ok(FORM_SPECS.oath);
  assert.ok(FORM_SPECS["emergency-contact"]);
  assert.ok(FORM_SPECS["onbase-emergency-contact"]);
  assert.ok(FORM_SPECS.verify);
  assert.ok(FORM_SPECS.i9);
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
  assert.equal(list.length, 5);
  const oath = list.find((f) => f.formType === "oath");
  assert.ok(oath);
  assert.equal(oath.label, "Oath signature");
  assert.equal(oath.rosterMode, "required");
  const verify = list.find((f) => f.formType === "verify");
  assert.ok(verify);
  assert.equal(verify.rosterMode, "optional");
  assert.equal(verify.hasApproveFanOut, false);
  const onbase = list.find((f) => f.formType === "onbase-emergency-contact");
  assert.ok(onbase);
  assert.equal(onbase.rosterMode, "required");
  assert.equal(onbase.hasApproveFanOut, true);
  const i9 = list.find((f) => f.formType === "i9");
  assert.ok(i9);
  assert.equal(i9.rosterMode, "optional");
  assert.equal(i9.hasApproveFanOut, false);
});
