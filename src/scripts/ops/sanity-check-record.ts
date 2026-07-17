/**
 * Operator CLI: pre-submit sanity check for an HR record.
 *
 * Feed a JSON record (a file arg or piped on stdin) and get back any implausible
 * / malformed / inconsistent fields — deterministic rule checks (email / DOB /
 * EID formats auto-detected from field names) plus an LLM cross-field pass over
 * the free-tier pool. Advisory: it exits 0 with warnings, 3 only when a blocking
 * `error`-severity issue is found, so it can gate a script if you want.
 *
 * Usage:
 *   tsx --env-file=.env src/scripts/ops/sanity-check-record.ts record.json [--workflow onboarding]
 *   echo '{"name":"Doe, Jane","workEmail":"jane@ucsd","employeeId":"123"}' \
 *     | tsx --env-file=.env src/scripts/ops/sanity-check-record.ts --workflow onboarding
 *   # rules only (no LLM / no API keys needed): add --no-llm
 */
import { readFileSync } from "node:fs";
import {
  sanityCheckRecord,
  inferRuleSpec,
  hasBlockingIssue,
  summarizeSanityIssues,
  type CheckableRecord,
} from "../../services/llm/sanity-check.js";

interface ParsedArgs {
  file?: string;
  workflow?: string;
  useLlm: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let file: string | undefined;
  let workflow: string | undefined;
  let useLlm = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workflow") workflow = argv[++i];
    else if (a === "--no-llm") useLlm = false;
    else if (!a.startsWith("--")) file = a;
  }
  return { file, workflow, useLlm };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = args.file ? readFileSync(args.file, "utf8") : await readStdin();
  if (!raw.trim()) {
    console.log("Usage: tsx --env-file=.env src/scripts/ops/sanity-check-record.ts <record.json> [--workflow W] [--no-llm]");
    process.exitCode = 2;
    return;
  }

  let record: CheckableRecord;
  try {
    // Flatten one level so nested objects (employee.name) still get scanned by
    // the LLM pass; rule field-name inference works on the flattened keys.
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    record = flatten(parsed);
  } catch (err) {
    console.log(`Could not parse JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  const issues = await sanityCheckRecord(record, {
    rules: inferRuleSpec(record),
    useLlm: args.useLlm,
    workflow: args.workflow,
  });

  if (issues.length === 0) {
    console.log("✓ No sanity issues found.");
    return;
  }
  console.log("");
  for (const i of issues) {
    console.log(`${i.severity === "error" ? "✗" : "⚠"} [${i.source}] ${i.field}: ${i.message}`);
  }
  console.log("");
  console.log(summarizeSanityIssues(issues));
  if (hasBlockingIssue(issues)) process.exitCode = 3;
}

/** Flatten a nested object one+ levels deep into `a.b` dotted string keys. */
function flatten(obj: Record<string, unknown>, prefix = ""): CheckableRecord {
  const out: CheckableRecord = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flatten(v as Record<string, unknown>, key));
    } else if (v == null) {
      out[key] = null;
    } else if (typeof v === "string") {
      out[key] = v;
    } else if (
      typeof v === "number" || typeof v === "boolean" ||
      typeof v === "bigint" || typeof v === "symbol"
    ) {
      out[key] = String(v);
    }
  }
  return out;
}

main().catch((err) => {
  console.log(`sanity-check-record error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
