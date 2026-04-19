import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { exportSchemas } from "../../../../src/scripts/codegen/export-schemas.js";

// One-shot tmp dir shared across the suite — exportSchemas is deterministic
// and write-only; no need for a per-test reset.
const TMP_DIR = join(
  os.tmpdir(),
  `export-schemas-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

after(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("exportSchemas", () => {
  it("writes one *.schema.json per registered workflow to outDir", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const results = exportSchemas(TMP_DIR);

    assert.ok(
      results.length >= 6,
      `expected at least 6 workflow schemas, got ${results.length}`,
    );

    const filenames = readdirSync(TMP_DIR).filter((f) => f.endsWith(".schema.json"));
    assert.equal(filenames.length, results.length);

    // Spot-check a few expected workflow names — matches the SCHEMA_REGISTRY.
    const byName = new Set(results.map((r) => r.workflowName));
    for (const expected of [
      "work-study",
      "emergency-contact",
      "onboarding",
      "separations",
      "eid-lookup",
      "kronos-reports",
    ]) {
      assert.ok(byName.has(expected), `expected schema for ${expected}`);
    }
  });

  it("each generated file is valid JSON with $schema + type:object", () => {
    // Re-run fine — exportSchemas is idempotent.
    mkdirSync(TMP_DIR, { recursive: true });
    const results = exportSchemas(TMP_DIR);

    for (const r of results) {
      const raw = readFileSync(r.outputPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(
        parsed["$schema"],
        "https://json-schema.org/draft/2020-12/schema",
        `${r.workflowName} missing $schema`,
      );
      assert.equal(parsed["type"], "object", `${r.workflowName} is not type:object`);
      assert.ok(
        parsed["properties"] !== undefined,
        `${r.workflowName} missing properties`,
      );
    }
  });

  it("creates outDir if missing (mkdir -p semantics)", () => {
    const nestedDir = join(TMP_DIR, "nested", "schemas");
    assert.equal(existsSync(nestedDir), false);
    const results = exportSchemas(nestedDir);
    assert.equal(existsSync(nestedDir), true);
    assert.ok(results.length > 0);
  });
});
