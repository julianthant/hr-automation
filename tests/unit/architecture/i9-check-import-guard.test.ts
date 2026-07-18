/**
 * Architecture guard — the i9-check workflow is SEARCH-ONLY.
 *
 * `src/workflows/i9-check/` owns the I-9 retention check (split out of the
 * separations daemon 2026-07-17). Its import surface is the structural proof
 * that an i9-check task cannot mutate a live HR system: no Kuali modules, no
 * UCPath transaction/Smart-HR writers, no Kronos. The guard sweeps EVERY
 * module in the workflow directory (check step, workflow definition, schema),
 * not just the step file. If this test fails, either the workflow gained a
 * mutating dependency (remove it) or a legitimately read-only helper moved
 * into a banned module (move the helper or extend the rationale here — never
 * just widen the ban list).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_DIR = join(process.cwd(), "src/workflows/i9-check");

const BANNED_IMPORT_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /systems\/kuali\//, why: "Kuali writes (form fills, finalization save)" },
  { pattern: /ucpath\/transaction/, why: "UCPath Smart HR transaction create/submit/delete" },
  { pattern: /ucpath\/ss-smart-hr/, why: "SS Smart HR transaction search/reuse" },
  { pattern: /systems\/(new-kronos|old-kronos)\//, why: "Kronos timecard access" },
  { pattern: /separations\/steps\//, why: "termination step modules" },
];

describe("i9-check workflow import guard (search-only)", () => {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 3, `expected the i9-check workflow modules, saw: ${files.join(", ")}`);

  for (const file of files) {
    const source = readFileSync(join(WORKFLOW_DIR, file), "utf8");
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\b|from\s+"/.test(line));

    for (const { pattern, why } of BANNED_IMPORT_PATTERNS) {
      it(`${file} never imports ${pattern} (${why})`, () => {
        const hits = importLines.filter((line) => pattern.test(line));
        assert.deepEqual(
          hits,
          [],
          `i9-check/${file} must stay search-only — banned import (${why}): ${hits.join("; ")}`,
        );
      });
    }
  }

  it("the check step imports the read-only search primitives it is allowed to use", () => {
    const source = readFileSync(join(WORKFLOW_DIR, "check.ts"), "utf8");
    assert.match(source, /systems\/ucpath\/navigate\.js/, "searchPerson import expected");
    assert.match(source, /person-lookup\/lookup\.js/, "lookupPersonInUcpath import expected");
    assert.match(source, /select-by-hire-date\.js/, "hire-date corroboration helper expected");
  });

  it("hire-date helper stays pure (datesWithinDays only — no browser)", () => {
    const source = readFileSync(join(WORKFLOW_DIR, "select-by-hire-date.ts"), "utf8");
    assert.match(source, /person-lookup\/crm-search\.js/, "datesWithinDays import expected");
    assert.doesNotMatch(source, /playwright|page\(/i);
  });
});
