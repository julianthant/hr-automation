import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  InvalidWorkflowNameError,
  WorkflowAlreadyExistsError,
  kebabToCamel,
  kebabToPascal,
  scaffold,
  parseArgv,
} from "../../../../src/scripts/codegen/new-workflow.js";

function mkTmp(): string {
  const dir = join(
    os.tmpdir(),
    `new-workflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function rmTmp(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

describe("kebabToPascal", () => {
  it("converts kebab-case to PascalCase", () => {
    assert.equal(kebabToPascal("wage-update"), "WageUpdate");
    assert.equal(kebabToPascal("new-hire-report"), "NewHireReport");
    assert.equal(kebabToPascal("foo"), "Foo");
  });
});

describe("kebabToCamel", () => {
  it("converts kebab-case to camelCase", () => {
    assert.equal(kebabToCamel("wage-update"), "wageUpdate");
    assert.equal(kebabToCamel("new-hire-report"), "newHireReport");
  });
});

describe("scaffold", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkTmp();
  });

  afterEach(() => {
    rmTmp(tmp);
  });

  it("creates all 5 canonical files with expected names", () => {
    const result = scaffold("wage-update", tmp);
    assert.ok(result.dir.endsWith("wage-update"));
    assert.equal(result.files.length, 5);

    const expected = ["schema.ts", "workflow.ts", "config.ts", "index.ts", "CLAUDE.md"];
    for (const name of expected) {
      const fpath = join(result.dir, name);
      assert.ok(existsSync(fpath), `expected file ${name} to exist`);
    }
  });

  it("renders schema.ts with an exported Zod InputSchema", () => {
    const result = scaffold("wage-update", tmp);
    const schema = readFileSync(join(result.dir, "schema.ts"), "utf-8");
    assert.match(schema, /export const WageUpdateInputSchema/);
    assert.match(schema, /export type WageUpdateInput/);
    // Uses zod/v4 like other workflows.
    assert.match(schema, /from "zod\/v4"/);
  });

  it("renders workflow.ts with defineWorkflow + CLI adapter", () => {
    const result = scaffold("wage-update", tmp);
    const workflow = readFileSync(join(result.dir, "workflow.ts"), "utf-8");
    assert.match(workflow, /defineWorkflow/);
    assert.match(workflow, /export const wageUpdateWorkflow/);
    assert.match(workflow, /export async function runWageUpdate/);
    assert.match(workflow, /dryRun/);
    // Single UCPath system, single step, single detail field — matches the spec.
    assert.match(workflow, /id: "ucpath"/);
    assert.match(workflow, /"do-thing"/);
  });

  it("renders index.ts barrel with schema + runner exports", () => {
    const result = scaffold("wage-update", tmp);
    const barrel = readFileSync(join(result.dir, "index.ts"), "utf-8");
    assert.match(barrel, /WageUpdateInputSchema/);
    assert.match(barrel, /runWageUpdate/);
    assert.match(barrel, /wageUpdateWorkflow/);
  });

  it("renders CLAUDE.md template with Files / Data Flow / Gotchas / Lessons", () => {
    const result = scaffold("wage-update", tmp);
    const claude = readFileSync(join(result.dir, "CLAUDE.md"), "utf-8");
    assert.match(claude, /# WageUpdate Workflow/);
    assert.match(claude, /## Files/);
    assert.match(claude, /## Data Flow/);
    assert.match(claude, /## Gotchas/);
    assert.match(claude, /## Lessons Learned/);
  });

  it("refuses to overwrite an existing directory", () => {
    scaffold("wage-update", tmp);
    assert.throws(
      () => scaffold("wage-update", tmp),
      (err: unknown) => err instanceof WorkflowAlreadyExistsError,
    );
  });

  it("rejects non-kebab-case names", () => {
    assert.throws(
      () => scaffold("WageUpdate", tmp),
      (err: unknown) => err instanceof InvalidWorkflowNameError,
    );
    assert.throws(
      () => scaffold("wage_update", tmp),
      (err: unknown) => err instanceof InvalidWorkflowNameError,
    );
    assert.throws(
      () => scaffold("1wage", tmp),
      (err: unknown) => err instanceof InvalidWorkflowNameError,
    );
    assert.throws(
      () => scaffold("", tmp),
      (err: unknown) => err instanceof InvalidWorkflowNameError,
    );
  });

  it("renders 'No systems declared' Selector Intelligence section when --systems omitted", () => {
    const result = scaffold("wage-update", tmp);
    const claude = readFileSync(join(result.dir, "CLAUDE.md"), "utf-8");
    assert.match(claude, /## Selector Intelligence/);
    assert.match(claude, /No systems declared/);
    // Existing scaffolded sections still present.
    assert.match(claude, /## Files/);
    assert.match(claude, /## Data Flow/);
    assert.match(claude, /## Gotchas/);
    assert.match(claude, /## Lessons Learned/);
  });

  it("embeds per-system selector-intelligence links when --systems provided", () => {
    const result = scaffold("wage-update", tmp, { systems: ["crm", "ucpath"] });
    const claude = readFileSync(join(result.dir, "CLAUDE.md"), "utf-8");
    assert.match(claude, /## Selector Intelligence/);
    assert.match(claude, /This workflow touches: crm, ucpath/);
    assert.match(claude, /\.\.\/\.\.\/systems\/crm\/LESSONS\.md/);
    assert.match(claude, /\.\.\/\.\.\/systems\/crm\/SELECTORS\.md/);
    assert.match(claude, /\.\.\/\.\.\/systems\/crm\/common-intents\.txt/);
    assert.match(claude, /\.\.\/\.\.\/systems\/ucpath\/LESSONS\.md/);
    assert.match(claude, /\.\.\/\.\.\/systems\/ucpath\/SELECTORS\.md/);
    assert.match(claude, /\.\.\/\.\.\/systems\/ucpath\/common-intents\.txt/);
    // Existing scaffolded sections still present.
    assert.match(claude, /## Files/);
    assert.match(claude, /## Data Flow/);
    assert.match(claude, /## Gotchas/);
    assert.match(claude, /## Lessons Learned/);
  });
});

describe("parseArgv", () => {
  it("parses bare workflow name with no flags", () => {
    const parsed = parseArgv(["node", "new-workflow.ts", "wage-update"]);
    assert.equal(parsed.name, "wage-update");
    assert.deepEqual(parsed.systems, []);
  });

  it("parses --systems flag (space-separated value form)", () => {
    const parsed = parseArgv([
      "node",
      "new-workflow.ts",
      "wage-update",
      "--systems",
      "crm,ucpath",
    ]);
    assert.equal(parsed.name, "wage-update");
    assert.deepEqual(parsed.systems, ["crm", "ucpath"]);
  });

  it("parses --systems=value form", () => {
    const parsed = parseArgv([
      "node",
      "new-workflow.ts",
      "wage-update",
      "--systems=crm,ucpath,i9",
    ]);
    assert.equal(parsed.name, "wage-update");
    assert.deepEqual(parsed.systems, ["crm", "ucpath", "i9"]);
  });

  it("trims whitespace and drops empty entries from --systems", () => {
    const parsed = parseArgv([
      "node",
      "new-workflow.ts",
      "wage-update",
      "--systems",
      " crm , , ucpath ",
    ]);
    assert.deepEqual(parsed.systems, ["crm", "ucpath"]);
  });

  it("accepts the --systems flag before the workflow name", () => {
    const parsed = parseArgv([
      "node",
      "new-workflow.ts",
      "--systems",
      "crm",
      "wage-update",
    ]);
    assert.equal(parsed.name, "wage-update");
    assert.deepEqual(parsed.systems, ["crm"]);
  });
});
