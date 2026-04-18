// tests/unit/scripts/lessons-format.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SYSTEMS_DIR = "src/systems";
const REQUIRED_SUBSECTIONS = ["**Tried:**", "**Failed because:**", "**Fix:**", "**Tags:**"];

test("every LESSONS.md entry has required subsections", () => {
  for (const sys of readdirSync(SYSTEMS_DIR)) {
    const path = join(SYSTEMS_DIR, sys, "LESSONS.md");
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue; // No LESSONS.md is valid for systems without selectors yet.
    }
    if (!stat.isFile()) continue;

    const md = readFileSync(path, "utf8");
    const sections = md.split(/^## /m).slice(1);
    for (const section of sections) {
      const headerLine = section.split("\n")[0];
      // Every H2 should start with an ISO date prefix: "YYYY-MM-DD — ..."
      assert.match(
        headerLine,
        /^\d{4}-\d{2}-\d{2}\s*[—-]\s*.+/,
        `LESSONS.md (${sys}): H2 "${headerLine}" missing ISO date prefix`,
      );
      for (const required of REQUIRED_SUBSECTIONS) {
        assert.ok(
          section.includes(required),
          `LESSONS.md (${sys}): entry "${headerLine}" missing subsection "${required}"`,
        );
      }
    }
  }
});
