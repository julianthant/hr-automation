import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { it } from "vitest";

const BANNED_TERM = "origin" + "Workflow";
const SEARCH_ROOTS = ["src", join("tests", "unit")];

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      yield* walkFiles(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

function findBannedTermMatches(): string[] {
  const pattern = new RegExp(String.raw`\b${BANNED_TERM}\b`);
  const matches: string[] = [];

  for (const root of SEARCH_ROOTS) {
    for (const file of walkFiles(join(process.cwd(), root))) {
      const text = readFileSync(file, "utf8");
      if (!pattern.test(text)) {
        continue;
      }

      text.split(/\r?\n/).forEach((line, index) => {
        if (pattern.test(line)) {
          matches.push(`${relative(process.cwd(), file)}:${index + 1}:${line.trim()}`);
        }
      });
    }
  }

  return matches;
}

it("does not reintroduce origin workflow lineage fields", () => {
  assert.deepEqual(findBannedTermMatches(), []);
});
