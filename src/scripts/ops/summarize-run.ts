/**
 * Operator CLI: summarize a workflow run's logs into a plain-English digest.
 *
 * Feed the run's log lines (a `.tracker/logs/*.jsonl` slice or any log text) and
 * get back what the run did, how it ended, and — if it failed — the likely
 * reason. Read-only, on-demand; touches no run state.
 *
 * Usage:
 *   tsx --env-file=.env src/scripts/ops/summarize-run.ts run.log [--workflow separations]
 *   # or grep one run out of a day's log and pipe it:
 *   grep '"runId":"3885#1"' .tracker/logs/separations-2026-07-01.jsonl \
 *     | tsx --env-file=.env src/scripts/ops/summarize-run.ts --workflow separations
 */
import { readFileSync } from "node:fs";
import { summarizeRun } from "../../services/llm/summarize-run.js";

interface ParsedArgs {
  file?: string;
  workflow?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let file: string | undefined;
  let workflow: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workflow") workflow = argv[++i];
    else if (!a.startsWith("--")) file = a;
  }
  return { file, workflow };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logText = args.file ? readFileSync(args.file, "utf8") : await readStdin();
  if (!logText.trim()) {
    console.log("Usage: tsx --env-file=.env src/scripts/ops/summarize-run.ts <run.log> [--workflow W]   (or pipe log lines on stdin)");
    process.exitCode = 2;
    return;
  }

  const result = await summarizeRun({ logText, workflow: args.workflow });
  if (!result) {
    console.log("No summary — the LLM pool is exhausted / returned an unusable answer, or no provider keys are configured.");
    process.exitCode = 1;
    return;
  }
  console.log("");
  console.log(`Outcome:  ${result.outcome}`);
  console.log(`Summary:  ${result.summary}`);
  if (result.highlights.length > 0) {
    console.log("Highlights:");
    for (const h of result.highlights) console.log(`  • ${h}`);
  }
  console.log("");
}

main().catch((err) => {
  console.log(`summarize-run error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
