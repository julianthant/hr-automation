import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";
import { buildPrompt, computeSchemaJsonHash } from "../../../src/ocr/prompts.js";

const Sample = z.object({
  name: z.string(),
  age: z.number().int().nonnegative(),
});

describe("buildPrompt", () => {
  it("includes the schema name", () => {
    const p = buildPrompt({ schemaName: "Person", schema: Sample });
    assert.match(p, /Person/);
  });
  it("mentions handwriting + US format conventions", () => {
    const p = buildPrompt({ schemaName: "Person", schema: Sample });
    assert.match(p, /handwritten|handwriting/i);
    assert.match(p, /US|address/i);
  });
  it("returns the override verbatim when provided", () => {
    const p = buildPrompt({ schemaName: "X", schema: Sample, override: "CUSTOM" });
    assert.equal(p, "CUSTOM");
  });
});

describe("computeSchemaJsonHash", () => {
  it("returns a stable hash for the same schema", () => {
    const a = computeSchemaJsonHash(Sample);
    const b = computeSchemaJsonHash(Sample);
    assert.equal(a, b);
  });
  it("differs for structurally different schemas", () => {
    const Other = z.object({ name: z.string() });
    assert.notEqual(computeSchemaJsonHash(Sample), computeSchemaJsonHash(Other));
  });
});
