/**
 * Operator CLI: explain a workflow failure using the free-tier LLM pool.
 *
 * Paste a cryptic error (the raw first line `classifyError` couldn't map) and
 * get a category + plain-English cause + suggested recovery. Safe by design —
 * a read-only, on-demand consumer of `triageFailure`; it touches no run state
 * and never blocks a live workflow (the deliberate reason triage is NOT wired
 * into the fragile terminal-emit hot path).
 *
 * Usage:
 *   tsx --env-file=.env src/scripts/ops/triage-failure.ts "<error text>" \
 *     [--workflow separations] [--step transaction] [--system ucpath]
 *   # or pipe the error in:
 *   cat error.txt | tsx --env-file=.env src/scripts/ops/triage-failure.ts --workflow ocr
 *
 * Requires at least one provider key (GEMINI_API_KEY*, GROQ_API_KEY*, …); with
 * none configured it prints a clear "no LLM keys" note and exits non-zero.
 */
import { triageFailure, summarizeTriage } from "../../services/llm/triage.js";

interface ParsedArgs {
  error: string;
  workflow?: string;
  step?: string;
  systemId?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let workflow: string | undefined;
  let step: string | undefined;
  let systemId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workflow") workflow = argv[++i];
    else if (a === "--step") step = argv[++i];
    else if (a === "--system") systemId = argv[++i];
    else positional.push(a);
  }
  return { error: positional.join(" ").trim(), workflow, step, systemId };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const error = parsed.error || (await readStdin());
  if (!error) {
    console.log('Usage: tsx --env-file=.env src/scripts/ops/triage-failure.ts "<error text>" [--workflow W] [--step S] [--system SYS]');
    process.exitCode = 2;
    return;
  }

  const result = await triageFailure({
    rawError: error,
    workflow: parsed.workflow,
    step: parsed.step,
    systemId: parsed.systemId,
  });

  if (!result) {
    console.log(
      "No triage available — the LLM pool is exhausted, returned an unusable answer, or no provider keys are configured (set GEMINI_API_KEY*, GROQ_API_KEY*, MISTRAL_API_KEY*, OPEN_ROUTER_API_KEY*, or SAMBANOVA_API_KEY*).",
    );
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log(`Category:   ${result.category}${result.retriable ? "  (retriable)" : "  (not retriable)"}`);
  console.log(`Cause:      ${result.cause}`);
  console.log(`Recovery:   ${result.suggestedRecovery}`);
  console.log(`Confidence: ${(result.confidence * 100).toFixed(0)}%`);
  console.log("");
  console.log(summarizeTriage(result));
}

main().catch((err) => {
  console.log(`triage-failure error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
