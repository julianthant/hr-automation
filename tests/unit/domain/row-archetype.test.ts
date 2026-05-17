import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type RowArchetype,
  archetypeRowTypeLabel,
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
});
