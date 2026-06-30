/**
 * Unit tests for the Data Bank drag-and-drop seam — the (de)serialization that
 * carries an op across an HTML5 drag from the palette to the canvas, plus the
 * op→action-node-data projection. parseOpDragPayload must be total (never throw)
 * so a stray drag is a no-op, not a crash.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import {
  DATA_BANK_DRAG_MIME,
  serializeOpDrag,
  parseOpDragPayload,
  opToActionData,
} from "../../../../src/dashboard/components/workflow-modifier/graph/data-bank-dnd.js";
import type { DataBankOperation } from "../../../../src/domain/workflow-design/data-bank.js";

const OP: DataBankOperation = {
  id: "kuali.separationForm.eid#fill",
  kind: "fill",
  system: "kuali",
  label: "Fill EID",
  summary: "type the EID into the form",
  selectorFqn: "kualiSelectors.separationForm.eid",
  role: "textbox",
  accessibleName: "EID*",
  inputVar: "{eid}",
  sourceRef: "src/systems/kuali/selectors.ts:96",
  verified: "2026-06-25",
  tags: ["@automation"],
  note: "8 digits",
};

describe("DATA_BANK_DRAG_MIME", () => {
  test("is a custom (non-text) mime so stray text/file drags never read as ops", () => {
    assert.equal(DATA_BANK_DRAG_MIME, "application/x-databank-op");
    assert.ok(!DATA_BANK_DRAG_MIME.startsWith("text/"));
  });
});

describe("serializeOpDrag / parseOpDragPayload", () => {
  test("round-trips a full op", () => {
    const parsed = parseOpDragPayload(serializeOpDrag(OP));
    assert.deepEqual(parsed, OP);
  });

  test("returns null for malformed JSON", () => {
    assert.equal(parseOpDragPayload("{not json"), null);
  });

  test("returns null for null / empty payloads", () => {
    assert.equal(parseOpDragPayload(null), null);
    assert.equal(parseOpDragPayload(undefined), null);
    assert.equal(parseOpDragPayload(""), null);
  });

  test("returns null when the required identity fields are missing (a foreign drag)", () => {
    assert.equal(parseOpDragPayload(JSON.stringify({ hello: "world" })), null);
    assert.equal(parseOpDragPayload(JSON.stringify({ id: "x", kind: "fill" })), null); // no system/label
    assert.equal(parseOpDragPayload(JSON.stringify(["a", "b"])), null);
    assert.equal(parseOpDragPayload(JSON.stringify("just a string")), null);
  });

  test("accepts a minimal op carrying only the required fields", () => {
    const min = { id: "control.delegate#control", kind: "control", system: "control", label: "Delegate" };
    assert.deepEqual(parseOpDragPayload(JSON.stringify(min)), min);
  });
});

describe("opToActionData", () => {
  test("keeps the node-relevant fields and drops palette-only provenance", () => {
    const data = opToActionData(OP);
    assert.equal(data.opId, OP.id);
    assert.equal(data.kind, "fill");
    assert.equal(data.system, "kuali");
    assert.equal(data.label, "Fill EID");
    assert.equal(data.selectorFqn, "kualiSelectors.separationForm.eid");
    assert.equal(data.role, "textbox");
    assert.equal(data.accessibleName, "EID*");
    assert.equal(data.inputVar, "{eid}");
    assert.equal(data.note, "8 digits");
    // palette-only fields are not carried onto the node
    assert.ok(!("summary" in data));
    assert.ok(!("sourceRef" in data));
    assert.ok(!("verified" in data));
    assert.ok(!("tags" in data));
  });
});
