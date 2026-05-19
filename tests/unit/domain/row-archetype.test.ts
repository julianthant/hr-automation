import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type RowArchetype,
  archetypeRowTypeLabel,
  deriveRowArchetype,
  resolveRowArchetype,
} from "../../../src/domain/row-archetype.js";

describe("row-archetype", () => {
  it("archetypeRowTypeLabel returns the canonical label per archetype", () => {
    assert.equal(archetypeRowTypeLabel("single"), "Single");
    assert.equal(archetypeRowTypeLabel("batch-parent"), "Batch parent");
    assert.equal(archetypeRowTypeLabel("batch-member"), "Batch member");
    assert.equal(archetypeRowTypeLabel("dispatch"), "Dispatch");
    assert.equal(archetypeRowTypeLabel("delegate-child"), "Delegated");
    assert.equal(archetypeRowTypeLabel("passive-child"), "Passive");
  });

  it("resolveRowArchetype prefers data.archetype when present", () => {
    const entry = { workflow: "oath-signature", data: { archetype: "delegate-child" as RowArchetype } };
    assert.equal(resolveRowArchetype(entry), "delegate-child");
  });

  it("resolveRowArchetype derives batch-parent from legacy data.mode === 'prepare'", () => {
    const entry = { workflow: "emergency-contact", data: { mode: "prepare" } };
    assert.equal(resolveRowArchetype(entry), "batch-parent");
  });

  it("resolveRowArchetype derives dispatch from legacy requestRole", () => {
    const entry = { workflow: "ocr", data: { requestRole: "delegation-dispatch" } };
    assert.equal(resolveRowArchetype(entry), "dispatch");
  });

  it("resolveRowArchetype derives passive-child from legacy taskRole === 'utility' + originWorkflow", () => {
    const entry = { workflow: "sharepoint-download", data: { taskRole: "utility", originWorkflow: "ocr" } };
    assert.equal(resolveRowArchetype(entry), "passive-child");
  });

  it("resolveRowArchetype falls back to single", () => {
    const entry = { workflow: "work-study", data: {} };
    assert.equal(resolveRowArchetype(entry), "single");
  });

  it("deriveRowArchetype: batch without parentRunId → batch-parent", () => {
    assert.equal(deriveRowArchetype("batch"), "batch-parent");
    assert.equal(deriveRowArchetype("batch", undefined), "batch-parent");
  });

  it("deriveRowArchetype: batch with parentRunId → delegate-child", () => {
    assert.equal(deriveRowArchetype("batch", "parent-run-1"), "delegate-child");
  });

  it("resolveRowArchetype derives batch-parent from legacy ocr workflow without parentRunId", () => {
    const entry = { workflow: "ocr", data: {} };
    assert.equal(resolveRowArchetype(entry), "batch-parent");
  });

  it("resolveRowArchetype does not classify OCR child rows as batch-parent", () => {
    const entry = {
      workflow: "ocr",
      parentRunId: "parent-run-1",
      data: { taskRole: "child", originWorkflow: "ocr" },
    };
    assert.equal(resolveRowArchetype(entry), "delegate-child");
  });

  it("deriveRowArchetype: utility with parentRunId → passive-child", () => {
    assert.equal(deriveRowArchetype("utility", "parent-run-1"), "passive-child");
  });

  it("deriveRowArchetype: utility without parentRunId → single", () => {
    assert.equal(deriveRowArchetype("utility"), "single");
  });
});
