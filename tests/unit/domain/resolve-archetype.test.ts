import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  resolveArchetype,
  resolveArchetypeFromValue,
  type WorkflowArchetype,
} from "../../../src/domain/row-archetype.js";

describe("resolveArchetype / resolveArchetypeFromValue", () => {
  it("returns the literal when archetype is a string", () => {
    for (const v of ["single","preview","operation"] as const) {
      assert.equal(resolveArchetype({ name: "test", archetype: v }, {}), v);
    }
  });

  it("invokes the resolver function with the input and returns its result", () => {
    type Input = { kind: "pdf" | "signer" };
    const archetype = (input: Input): WorkflowArchetype =>
      input.kind === "pdf" ? "operation" : "single";
    assert.equal(resolveArchetype({ name: "oath-signature", archetype }, { kind: "pdf" }), "operation");
    assert.equal(resolveArchetype({ name: "oath-signature", archetype }, { kind: "signer" }), "single");
  });

  it("returns each valid WorkflowArchetype value from a resolver", () => {
    const all: WorkflowArchetype[] = ["single","preview","operation"];
    for (const value of all) {
      assert.equal(resolveArchetype({ name: "test", archetype: () => value }, undefined), value);
    }
  });

  it("throws when the resolver returns a non-WorkflowArchetype value", () => {
    assert.throws(
      () => resolveArchetype({ name: "broken-workflow", archetype: () => "not-a-real-archetype" as unknown as WorkflowArchetype }, {}),
      /broken-workflow.*not a valid WorkflowArchetype/,
    );
    assert.throws(
      () => resolveArchetype({ name: "broken-workflow", archetype: () => 42 as unknown as WorkflowArchetype }, {}),
      /broken-workflow.*not a valid WorkflowArchetype/,
    );
    assert.throws(
      () => resolveArchetype({ name: "broken-workflow", archetype: () => undefined as unknown as WorkflowArchetype }, {}),
      /broken-workflow.*not a valid WorkflowArchetype/,
    );
  });

  it("throws when called with an undefined archetype (defensive)", () => {
    assert.throws(
      () => resolveArchetype({ name: "no-archetype" }, {}),
      /no-archetype.*no archetype declared/,
    );
  });

  it("resolveArchetypeFromValue exposes the same behavior without a config wrapper", () => {
    assert.equal(resolveArchetypeFromValue<unknown>("operation", undefined, "direct"), "operation");
    assert.equal(
      resolveArchetypeFromValue<{ x: number }>((input) => (input.x > 0 ? "operation" : "single"), { x: 1 }, "direct"),
      "operation",
    );
    assert.throws(
      () => resolveArchetypeFromValue<unknown>((() => "wrong") as unknown as () => WorkflowArchetype, undefined, "direct"),
      /direct.*not a valid WorkflowArchetype/,
    );
  });
});
