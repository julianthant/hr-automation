// Export each workflow's Zod input schema as a JSON Schema file in `schemas/`.
//
// Usage:
//   npm run schemas:export
//
// How it works:
//   * Import each workflow's `index.ts` barrel — that's side-effect-free (no
//     Commander CLI startup) but pulls in `workflow.ts`, which calls
//     `defineWorkflow`, which registers the workflow into `src/core/registry`.
//   * For every registered workflow that has a matching `<Name>InputSchema` or
//     similar exported Zod schema in the workflow module, convert via Zod v4's
//     native `toJSONSchema` and write to `schemas/<workflow-name>.schema.json`.
//   * The `schemas/` directory is kept via `.gitkeep`; the generated
//     `*.schema.json` artifacts are gitignored (re-run this after a schema
//     change).
//
// Why not iterate the registry alone: the registry stores `WorkflowMetadata`
// (label, steps, detailFields) — it intentionally does NOT store the Zod
// schema. Each schema is exported from the workflow's `schema.ts` under a
// workflow-specific name (e.g. `WorkStudyInputSchema`, `EmployeeDataSchema`).
// We encode the mapping explicitly below so the script fails loudly if a
// workflow adds/removes/renames its input schema.

import { toJSONSchema } from "zod/v4";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Workflow index imports populate the kernel registry as a side-effect.
// Listed alphabetically; no need to actually use their exports here beyond the
// schemas below — the side-effect is what we care about for any future
// registry-based features.
import * as eidLookup from "../../workflows/eid-lookup/index.js";
import * as emergencyContact from "../../workflows/emergency-contact/index.js";
import * as oldKronosReports from "../../workflows/old-kronos-reports/index.js";
import * as onboarding from "../../workflows/onboarding/index.js";
import * as separations from "../../workflows/separations/index.js";
// separations/index.ts only re-exports helpers, not the schema itself — pull
// the schema from the underlying module directly.
import { SeparationDataSchema } from "../../workflows/separations/schema.js";
import * as workStudy from "../../workflows/work-study/index.js";

// Side-effect import kept for symmetry with other workflows (registers the
// separations workflow via `defineWorkflow`).
void separations;

/**
 * One entry per workflow. Each entry names the on-disk workflow ID (used for
 * the output filename) and the Zod schema to convert.
 *
 * The workflow name matches the registry key (e.g. `"kronos-reports"` for the
 * old-kronos-reports directory — same mismatch that exists in the kernel
 * registration).
 */
interface SchemaEntry {
  workflowName: string;
  // Zod v4 schemas are typed strictly; toJSONSchema accepts `ZodType<unknown>`.
  // Using `unknown` at the entry level avoids propagating TData generics.
  schema: Parameters<typeof toJSONSchema>[0];
}

// Avoid literal `as any` — cast lives in one place so any future breakage is
// localized + greppable.
type AnySchema = SchemaEntry["schema"];

const SCHEMA_REGISTRY: SchemaEntry[] = [
  { workflowName: "eid-lookup", schema: eidLookup.EidLookupInputSchema as unknown as AnySchema },
  { workflowName: "emergency-contact", schema: emergencyContact.BatchSchema as unknown as AnySchema },
  { workflowName: "kronos-reports", schema: oldKronosReports.KronosInputSchema as unknown as AnySchema },
  { workflowName: "onboarding", schema: onboarding.EmployeeDataSchema as unknown as AnySchema },
  { workflowName: "separations", schema: SeparationDataSchema as unknown as AnySchema },
  { workflowName: "work-study", schema: workStudy.WorkStudyInputSchema as unknown as AnySchema },
];

export interface ExportResult {
  workflowName: string;
  outputPath: string;
}

/**
 * Convert each Zod schema to JSON Schema and write to `<outDir>/<name>.schema.json`.
 *
 * Exported so tests can point it at a tmp dir without touching the real
 * `schemas/` directory at repo root.
 */
export function exportSchemas(outDir: string): ExportResult[] {
  mkdirSync(outDir, { recursive: true });

  const results: ExportResult[] = [];
  for (const entry of SCHEMA_REGISTRY) {
    const jsonSchema = toJSONSchema(entry.schema);
    const outputPath = path.join(outDir, `${entry.workflowName}.schema.json`);
    writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2) + "\n", "utf-8");
    results.push({ workflowName: entry.workflowName, outputPath });
  }
  return results;
}

// CLI entry point — skipped when the file is imported (tests only import the
// exported `exportSchemas` function).
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("export-schemas.ts");
if (isMain) {
  const outDir = path.resolve(process.cwd(), "schemas");
  const results = exportSchemas(outDir);
  for (const r of results) {
    process.stdout.write(`  ${r.workflowName} -> ${path.relative(process.cwd(), r.outputPath)}\n`);
  }
  process.stdout.write(`Wrote ${results.length} schemas to ${path.relative(process.cwd(), outDir)}/\n`);
}
