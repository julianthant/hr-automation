import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type RowArchetype,
  archetypeRowTypeLabel,
  deriveRowArchetype,
  resolveRowArchetype,
} from "../../../src/domain/row-archetype.js";

const CANONICAL: RowArchetype[] = [
  "single",
  "batch-parent",
  "batch-member",
  "dispatch",
  "delegate-child",
  "passive-child",
];

describe("row-archetype", () => {
  it("archetypeRowTypeLabel returns the canonical label per archetype", () => {
    assert.equal(archetypeRowTypeLabel("single"), "Single");
    assert.equal(archetypeRowTypeLabel("batch-parent"), "Batch parent");
    assert.equal(archetypeRowTypeLabel("batch-member"), "Batch member");
    assert.equal(archetypeRowTypeLabel("dispatch"), "Dispatch");
    assert.equal(archetypeRowTypeLabel("delegate-child"), "Delegated");
    assert.equal(archetypeRowTypeLabel("passive-child"), "Passive");
  });

  it("resolveRowArchetype returns every canonical data.archetype value", () => {
    for (const archetype of CANONICAL) {
      assert.equal(resolveRowArchetype({ data: { archetype } }), archetype);
    }
  });

  it("resolveRowArchetype defaults to single when data.archetype is missing", () => {
    assert.equal(resolveRowArchetype({ data: {} }), "single");
    assert.equal(resolveRowArchetype({}), "single");
  });

  it("resolveRowArchetype defaults to delegate-child when parentRunId is set", () => {
    assert.equal(resolveRowArchetype({ parentRunId: "parent-run-1", data: {} }), "delegate-child");
  });

  it("resolveRowArchetype treats invalid data.archetype as missing", () => {
    assert.equal(resolveRowArchetype({ data: { archetype: "not-a-real-archetype" } }), "single");
    assert.equal(
      resolveRowArchetype({ parentRunId: "parent-run-1", data: { archetype: 42 } }),
      "delegate-child",
    );
  });

  it("deriveRowArchetype: batch without parentRunId → batch-parent", () => {
    assert.equal(deriveRowArchetype("batch"), "batch-parent");
    assert.equal(deriveRowArchetype("batch", undefined), "batch-parent");
  });

  it("deriveRowArchetype: batch with parentRunId → delegate-child", () => {
    assert.equal(deriveRowArchetype("batch", "parent-run-1"), "delegate-child");
  });

  it("deriveRowArchetype: utility with parentRunId → passive-child", () => {
    assert.equal(deriveRowArchetype("utility", "parent-run-1"), "passive-child");
  });

  it("deriveRowArchetype: utility without parentRunId → single", () => {
    assert.equal(deriveRowArchetype("utility"), "single");
  });
});
