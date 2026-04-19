// src/scripts/selector-search.ts
//
// CLI fuzzy search across every system's SELECTORS.md and LESSONS.md.
//
// Usage:
//   npm run selector:search "<intent>"
//
// Prints top 10 ranked matches with file:line refs.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  parseSelectorsMarkdown,
  parseLessonsMarkdown,
  rank,
  type IndexedItem,
} from "./search-lib.js";

const SYSTEMS_DIR = "src/systems";

function tryRead(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function loadIndex(): IndexedItem[] {
  const items: IndexedItem[] = [];
  for (const sys of readdirSync(SYSTEMS_DIR)) {
    const selPath = join(SYSTEMS_DIR, sys, "SELECTORS.md");
    const sel = tryRead(selPath);
    if (sel) items.push(...parseSelectorsMarkdown(sys, sel));

    const lessonsPath = join(SYSTEMS_DIR, sys, "LESSONS.md");
    const lessons = tryRead(lessonsPath);
    if (lessons) items.push(...parseLessonsMarkdown(sys, lessons));
  }
  return items;
}

function main(): void {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    console.error('Usage: npm run selector:search "<intent>"');
    console.error('Example: npm run selector:search "comp rate"');
    process.exit(1);
  }

  const items = loadIndex();
  if (items.length === 0) {
    console.error(
      "No SELECTORS.md or LESSONS.md found. Run `npm run selectors:catalog` first.",
    );
    process.exit(1);
  }

  const ranked = rank(items, query, 10);
  if (ranked.length === 0) {
    console.log(`No matches for "${query}".`);
    console.log(
      `Tip: try broader/related terms, or run \`grep -ri '${query}' src/systems/*/CLAUDE.md\`.`,
    );
    return;
  }

  console.log(`Top ${ranked.length} matches for "${query}":\n`);
  for (const { item, score } of ranked) {
    const kindLabel = item.kind === "selector" ? "[selector]" : "[lesson]  ";
    console.log(`${kindLabel}  [${item.system}/${item.title}]  score=${score.toFixed(1)}`);
    console.log(`           ref: ${item.ref}`);
    if (item.tags.length > 0) console.log(`           tags: ${item.tags.join(", ")}`);
    console.log();
  }
}

// Three-way guard matches clean-tracker.ts convention so the CLI fires
// whether invoked via tsx (.ts), compiled output (.js), or a path that
// matches `import.meta.url`.
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("search.ts") ||
  process.argv[1]?.endsWith("search.js");

if (isMainModule) {
  main();
}
