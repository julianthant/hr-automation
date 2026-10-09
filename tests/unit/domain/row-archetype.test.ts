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
  "operation",
  "operation-member",
];

describe("row-archetype", () => {
  it("archetypeRowTypeLabel returns the canonical label per archetype", () => {
    assert.equal(archetypeRowTypeLabel("single"), "Single");
    assert.equal(archetypeRowTypeLabel("preview"), "Preview");
    assert.equal(archetypeRowTypeLabel("operation"), "Operation");
    assert.equal(archetypeRowTypeLabel("operation-member"), "Operation member");
  });

  it("resolveRowArchetype returns every canonical data.archetype value", () => {
    for (const archetype of CANONICAL) {
      assert.equal(resolveRowArchetype({ data: { archetype } }), archetype);
    }
  });

  it("resolveRowArchetype normalizes legacy batch stamps", () => {
    assert.equal(resolveRowArchetype({ data: { archetype: "batch" } }), "operation");
    assert.equal(resolveRowArchetype({ data: { archetype: "batch-member" } }), "operation-member");
  });

  it("resolveRowArchetype defaults to single when data.archetype is missing", () => {
    assert.equal(resolveRowArchetype({ data: {} }), "single");
    assert.equal(resolveRowArchetype({}), "single");
  });

  it("resolveRowArchetype defaults to single when parentRunId is set", () => {
    assert.equal(resolveRowArchetype({ parentRunId: "parent-run-1", data: {} }), "single");
  });

  it("resolveRowArchetype throws when data.archetype is set but invalid", () => {
    assert.throws(
      () => resolveRowArchetype({ data: { archetype: "not-a-real-archetype" } }),
      /data\.archetype is set but not a valid RowArchetype/,
    );
    assert.throws(
      () => resolveRowArchetype({ parentRunId: "parent-run-1", data: { archetype: 42 } }),
      /data\.archetype is set but not a valid RowArchetype/,
    );
  });

  it("deriveRowArchetype: operation workflow → operation row", () => {
    assert.equal(deriveRowArchetype("operation"), "operation");
    assert.equal(deriveRowArchetype("operation", undefined), "operation");
  });

  it("deriveRowArchetype: preview → preview", () => {
    assert.equal(deriveRowArchetype("preview"), "preview");
    assert.equal(deriveRowArchetype("preview", "parent-run-1"), "preview");
  });

  it("deriveRowArchetype: operation with parentRunId → operation", () => {
    assert.equal(deriveRowArchetype("operation", "parent-run-1"), "operation");
  });

  it("deriveRowArchetype: member option → operation-member", () => {
    assert.equal(deriveRowArchetype("single", "parent-run-1", { member: true }), "operation-member");
    assert.equal(deriveRowArchetype("operation", undefined, { member: true }), "operation-member");
  });

  it("deriveRowArchetype: memberShape → operation-member", () => {
    assert.equal(
      deriveRowArchetype("single", "parent-run-1", { memberShape: "operation-member" }),
      "operation-member",
    );
    assert.equal(
      deriveRowArchetype("single", undefined, { member: true, memberShape: "operation-member" }),
      "operation-member",
    );
  });
});
