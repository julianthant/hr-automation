import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  type RowArchetype,
  archetypeRowTypeLabel,
  deriveRowArchetype,
  resolveRowArchetype,
} from "../../../src/domain/row-archetype.js";

const CANONICAL: RowArchetype[] = [
  "single",
  "preview",
  "batch-member",
  "batch",
];

describe("row-archetype", () => {
  it("archetypeRowTypeLabel returns the canonical label per archetype", () => {
    assert.equal(archetypeRowTypeLabel("single"), "Single");
    assert.equal(archetypeRowTypeLabel("preview"), "Preview");
    assert.equal(archetypeRowTypeLabel("batch"), "Batch");
    assert.equal(archetypeRowTypeLabel("batch-member"), "Batch member");
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

  it("resolveRowArchetype defaults to single when parentRunId is set", () => {
    assert.equal(resolveRowArchetype({ parentRunId: "parent-run-1", data: {} }), "single");
  });

  it("resolveRowArchetype throws when data.archetype is set but invalid", () => {
    // Production write code can't reach this state (StampedData type contract
    // on emitTrackerRow). An explicitly-invalid value is a bug worth surfacing.
    assert.throws(
      () => resolveRowArchetype({ data: { archetype: "not-a-real-archetype" } }),
      /data\.archetype is set but not a valid RowArchetype/,
    );
    assert.throws(
      () => resolveRowArchetype({ parentRunId: "parent-run-1", data: { archetype: 42 } }),
      /data\.archetype is set but not a valid RowArchetype/,
    );
  });

  it("deriveRowArchetype: batch without parentRunId → batch", () => {
    assert.equal(deriveRowArchetype("batch"), "batch");
    assert.equal(deriveRowArchetype("batch", undefined), "batch");
  });

  it("deriveRowArchetype: preview → preview", () => {
    assert.equal(deriveRowArchetype("preview"), "preview");
    assert.equal(deriveRowArchetype("preview", "parent-run-1"), "preview");
  });

  it("deriveRowArchetype: batch with parentRunId → batch", () => {
    assert.equal(deriveRowArchetype("batch", "parent-run-1"), "batch");
  });

  it("deriveRowArchetype: member option → batch-member", () => {
    assert.equal(deriveRowArchetype("single", "parent-run-1", { member: true }), "batch-member");
    assert.equal(deriveRowArchetype("batch", undefined, { member: true }), "batch-member");
  });
});
