// Scaffold a new kernel-based workflow under `src/workflows/<name>/`.
//
// Usage:
//   npm run new:workflow -- <name>
//
// Validates <name> is kebab-case, refuses to overwrite an existing directory,
// and emits 5 files: `schema.ts`, `workflow.ts`, `config.ts`, `index.ts`,
// `CLAUDE.md`. After scaffolding, prints a short next-steps checklist for
// the operator.
//
// The generated workflow is a minimal `defineWorkflow` example — single UCPath
// system, single step, single labeled detailField, dry-run branch that prints
// the planned action. The operator is expected to fill in the real handler,
// schema fields, and CLAUDE.md content.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Kebab-case: lowercase alnum + hyphens, must start with a lowercase letter. */
const KEBAB_RE = /^[a-z][a-z0-9-]+$/;

export class InvalidWorkflowNameError extends Error {
  constructor(name: string) {
    super(
      `Invalid workflow name "${name}" — must be kebab-case matching /^[a-z][a-z0-9-]+$/ ` +
        `(e.g. "wage-update", "new-hire-report").`,
    );
    this.name = "InvalidWorkflowNameError";
  }
}

export class WorkflowAlreadyExistsError extends Error {
  constructor(dir: string) {
    super(`Workflow directory already exists: ${dir} — refusing to overwrite.`);
    this.name = "WorkflowAlreadyExistsError";
  }
}

/**
 * Convert kebab-case to PascalCase (used for class/type names inside templates).
 * Pure — exported for testing.
 *
 * `wage-update` -> `WageUpdate`
 * `new-hire-report` -> `NewHireReport`
 */
export function kebabToPascal(name: string): string {
  return name
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Convert kebab-case to camelCase. Used for variable/function names.
 *
 * `wage-update` -> `wageUpdate`
 */
export function kebabToCamel(name: string): string {
  const pascal = kebabToPascal(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export interface ScaffoldResult {
  dir: string;
  files: string[];
}

export interface ScaffoldOptions {
  /**
   * Per-system slugs the new workflow will touch (e.g. `["crm", "ucpath"]`).
   * Used to embed per-system LESSONS.md / SELECTORS.md / common-intents.txt
   * links in the generated CLAUDE.md so the operator can scan existing
   * selectors before mapping a new one. Empty array (or omitted) renders a
   * placeholder section.
   */
  systems?: string[];
}

/**
 * Scaffold a new workflow directory with the 5 canonical files.
 *
 * @param name     Kebab-case workflow name (e.g. `wage-update`).
 * @param baseDir  Parent directory — `path.join(baseDir, name)` is created.
 *                 Defaults to `src/workflows/` under the current cwd.
 * @param options  Optional scaffolding hints, including the list of per-system
 *                 slugs the workflow will touch.
 * @throws {InvalidWorkflowNameError}    if `name` is not kebab-case.
 * @throws {WorkflowAlreadyExistsError}  if the target directory exists.
 */
export function scaffold(
  name: string,
  baseDir?: string,
  options: ScaffoldOptions = {},
): ScaffoldResult {
  if (!KEBAB_RE.test(name)) throw new InvalidWorkflowNameError(name);

  const targetBase = baseDir ?? path.join(process.cwd(), "src", "workflows");
  const targetDir = path.join(targetBase, name);
  if (existsSync(targetDir)) throw new WorkflowAlreadyExistsError(targetDir);

  mkdirSync(targetDir, { recursive: true });

  const pascalName = kebabToPascal(name);
  const camelName = kebabToCamel(name);
  const systems = options.systems ?? [];

  const files: Array<{ fname: string; content: string }> = [
    { fname: "schema.ts", content: renderSchema(pascalName) },
    { fname: "workflow.ts", content: renderWorkflow(name, pascalName, camelName) },
    { fname: "config.ts", content: renderConfig(name) },
    { fname: "index.ts", content: renderIndex(pascalName, camelName) },
    { fname: "CLAUDE.md", content: renderClaudeMd(name, pascalName, systems) },
  ];

  const written: string[] = [];
  for (const f of files) {
    const fpath = path.join(targetDir, f.fname);
    writeFileSync(fpath, f.content, "utf-8");
    written.push(fpath);
  }
  return { dir: targetDir, files: written };
}

// ─── Template renderers (pure — no side effects) ──────────────────────────────

function renderSchema(pascalName: string): string {
  return `import { z } from "zod/v4";

/** Input schema for the ${pascalName} workflow. Edit the fields below. */
export const ${pascalName}InputSchema = z.object({
  exampleId: z.string().min(1, "exampleId is required"),
});

export type ${pascalName}Input = z.infer<typeof ${pascalName}InputSchema>;
`;
}

function renderWorkflow(name: string, pascalName: string, camelName: string): string {
  return `import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { log } from "../../utils/log.js";
import { loginToUCPath } from "../../auth/login.js";
import { ${pascalName}InputSchema, type ${pascalName}Input } from "./schema.js";

export interface ${pascalName}Options {
  dryRun?: boolean;
}

const ${camelName}Steps = ["do-thing"] as const;

/**
 * Kernel definition for the ${name} workflow. Minimal scaffold — fill in real
 * systems, steps, and handler body before running.
 */
export const ${camelName}Workflow = defineWorkflow({
  name: "${name}",
  label: "${pascalName}",
  systems: [
    {
      id: "ucpath",
      login: async (page, instance) => {
        const ok = await loginToUCPath(page, instance);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
  ],
  steps: ${camelName}Steps,
  schema: ${pascalName}InputSchema,
  tiling: "single",
  authChain: "sequential",
  detailFields: [{ key: "exampleId", label: "Example ID" }],
  getId: (d) => d.exampleId ?? "",
  handler: async (ctx, input) => {
    ctx.updateData({ exampleId: input.exampleId });
    await ctx.step("do-thing", async () => {
      const page = await ctx.page("ucpath");
      log.step(\`${pascalName}: implement the real work here for \${input.exampleId}\`);
      void page;
    });
  },
});

/**
 * CLI adapter. Handles --dry-run preview (no browser); real runs delegate to
 * the kernel.
 */
export async function run${pascalName}(
  input: ${pascalName}Input,
  options: ${pascalName}Options = {},
): Promise<void> {
  if (options.dryRun) {
    log.step("=== DRY RUN MODE ===");
    log.step(\`${pascalName}: would process exampleId=\${input.exampleId}\`);
    log.success("Dry run complete -- no changes made");
    return;
  }

  await runWorkflow(${camelName}Workflow, input);
  log.success("${pascalName} completed successfully");
}
`;
}

function renderConfig(name: string): string {
  return `// Workflow-specific constants for ${name}. Extend with URLs, template IDs,
// or other static values as the workflow matures.
export const PLACEHOLDER = "" as const;
`;
}

function renderIndex(pascalName: string, camelName: string): string {
  return `export { ${pascalName}InputSchema } from "./schema.js";
export type { ${pascalName}Input } from "./schema.js";
export { run${pascalName}, ${camelName}Workflow } from "./workflow.js";
export type { ${pascalName}Options } from "./workflow.js";
`;
}

function renderSelectorIntelligence(systems: string[]): string {
  if (systems.length === 0) {
    return `## Selector Intelligence

No systems declared — add them by editing this file. After listing the systems
this workflow touches (e.g. \`ucpath\`, \`crm\`), insert per-system links:

- \`src/systems/<sys>/LESSONS.md\`
- \`src/systems/<sys>/SELECTORS.md\`
- \`src/systems/<sys>/common-intents.txt\`

Before mapping any new selector, run \`npm run selector:search "<intent>"\`
and review the top matches.
`;
  }
  const lines: string[] = ["## Selector Intelligence", ""];
  lines.push(`This workflow touches: ${systems.join(", ")}.`, "");
  lines.push("Before mapping a new selector, run `npm run selector:search \"<intent>\"`.", "");
  lines.push("Per-system catalogs and lessons:", "");
  for (const sys of systems) {
    lines.push(`- **${sys}** —`);
    lines.push(`  - [\`LESSONS.md\`](../../systems/${sys}/LESSONS.md)`);
    lines.push(`  - [\`SELECTORS.md\`](../../systems/${sys}/SELECTORS.md)`);
    lines.push(`  - [\`common-intents.txt\`](../../systems/${sys}/common-intents.txt)`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderClaudeMd(
  name: string,
  pascalName: string,
  systems: string[] = [],
): string {
  return `# ${pascalName} Workflow

One-line description of what this workflow does. Replace this line.

**Kernel-based.** Declared via \`defineWorkflow\` in \`workflow.ts\` and
executed through \`src/core/runWorkflow\`.

## Files

- \`schema.ts\` — Zod input schema
- \`workflow.ts\` — Kernel definition + CLI adapter
- \`config.ts\` — Workflow-specific constants
- \`index.ts\` — Barrel exports

${renderSelectorIntelligence(systems)}
## Data Flow

\`\`\`
CLI: npm run ${name} <exampleId>
  -> run${pascalName} (CLI adapter)
    -> if --dry-run: log planned action (no browser)
    -> else: runWorkflow(${pascalName.charAt(0).toLowerCase() + pascalName.slice(1)}Workflow, input)
      -> Kernel Session.launch: 1 browser, UCPath auth
      -> Handler step "do-thing" (fill me in)
\`\`\`

## Gotchas

*(Fill in system-specific pitfalls as you discover them.)*

## Lessons Learned

*(Add dated entries after each bug fix or design decision.)*
`;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

export interface ParsedArgv {
  name: string;
  systems: string[];
}

/**
 * Parse argv into a `{ name, systems }` tuple. Accepts both `tsx
 * new-workflow.ts <name> [--systems a,b]` and the npm passthrough form
 * `npm run new:workflow -- <name> --systems a,b`.
 *
 * Pure — exported for testing.
 */
export function parseArgv(argv: string[]): ParsedArgv {
  const args = argv.slice(2);
  if (args.length === 0) {
    process.stderr.write(
      "Usage: npm run new:workflow -- <name> [--systems sys1,sys2]\n" +
        "Example: npm run new:workflow -- wage-update --systems ucpath\n",
    );
    process.exit(1);
  }
  let name: string | undefined;
  let systems: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--systems") {
      const value = args[i + 1];
      if (typeof value !== "string") {
        process.stderr.write("--systems requires a comma-separated value\n");
        process.exit(1);
      }
      systems = value.split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (arg.startsWith("--systems=")) {
      systems = arg
        .slice("--systems=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (!arg.startsWith("--") && name === undefined) {
      name = arg;
    }
  }
  if (name === undefined) {
    process.stderr.write(
      "Missing workflow name (kebab-case, e.g. wage-update).\n",
    );
    process.exit(1);
  }
  return { name, systems };
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("new-workflow.ts");

if (isMain) {
  const { name, systems } = parseArgv(process.argv);
  try {
    const result = scaffold(name, undefined, { systems });
    process.stdout.write(`Created ${result.dir}\n`);
    for (const f of result.files) {
      process.stdout.write(`  ${path.relative(process.cwd(), f)}\n`);
    }
    process.stdout.write("\nNext steps:\n");
    process.stdout.write(`  1. Fill in schema fields in src/workflows/${name}/schema.ts\n`);
    process.stdout.write(`  2. Implement the handler body in src/workflows/${name}/workflow.ts\n`);
    process.stdout.write(`  3. Add Commander subcommand + package.json script\n`);
    process.stdout.write(`  4. Add workflow to the 'Step Tracking Per Workflow' table in root CLAUDE.md\n`);
    process.stdout.write(`  5. npm run schemas:export\n`);
  } catch (err) {
    if (err instanceof Error) {
      process.stderr.write(`Error: ${err.message}\n`);
    } else {
      process.stderr.write(`Error: ${String(err)}\n`);
    }
    process.exit(1);
  }
}
