/**
 * Operator/dev CLI: suggest candidate Playwright selectors from an a11y snapshot.
 *
 * Part of the selector-map loop. When a selector breaks, capture the page and
 * pipe the snapshot in with what you're trying to target:
 *
 *   playwright-cli -s=sel --raw snapshot > /tmp/snap.yml
 *   tsx --env-file=.env src/scripts/ops/selector-suggest.ts /tmp/snap.yml \
 *     --intent "the Save button" [--current "button.oldSave"]
 *   # or pipe:
 *   playwright-cli --raw snapshot | tsx --env-file=.env \
 *     src/scripts/ops/selector-suggest.ts --intent "Employee ID field"
 *
 * Prints candidate locators ranked most-likely first. You still VERIFY each one
 * live and add `// verified <date>` + regen the catalog per the selector-map
 * skill — this only proposes.
 */
import { readFileSync } from "node:fs";
import { suggestSelectors } from "../../services/llm/selector-suggest.js";

interface ParsedArgs {
  file?: string;
  intent?: string;
  current?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let file: string | undefined;
  let intent: string | undefined;
  let current: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--intent") intent = argv[++i];
    else if (a === "--current") current = argv[++i];
    else if (!a.startsWith("--")) file = a;
  }
  return { file, intent, current };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.intent) {
    console.log('Usage: tsx --env-file=.env src/scripts/ops/selector-suggest.ts [snapshot.yml] --intent "<what to target>" [--current "<broken selector>"]');
    process.exitCode = 2;
    return;
  }
  const snapshot = args.file ? readFileSync(args.file, "utf8") : await readStdin();
  if (!snapshot.trim()) {
    console.log("No snapshot provided — pass a file path or pipe `playwright-cli --raw snapshot` on stdin.");
    process.exitCode = 2;
    return;
  }

  const candidates = await suggestSelectors({ snapshot, intent: args.intent, current: args.current });
  if (!candidates) {
    console.log("No suggestions — the LLM pool is exhausted / returned an unusable answer, or no provider keys are configured.");
    process.exitCode = 1;
    return;
  }
  if (candidates.length === 0) {
    console.log("Nothing in the snapshot plausibly matches that intent. Re-check the snapshot or rephrase --intent.");
    return;
  }
  console.log("");
  candidates.forEach((c, i) => {
    console.log(`${i + 1}. ${c.selector}   (${(c.confidence * 100).toFixed(0)}%)`);
    console.log(`   ${c.rationale}`);
  });
  console.log("");
  console.log("Verify each live before committing; add `// verified <date>` + run `npm run selectors:catalog`.");
}

main().catch((err) => {
  console.log(`selector-suggest error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
