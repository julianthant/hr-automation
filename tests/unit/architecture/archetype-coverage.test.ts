/**
 * All workflow.ts files that contain a defineWorkflow call must declare an
 * explicit `archetype:` field. The kernel auto-assigns "single" or "batch"
 * from the batch config shape, but explicit declarations make the intent
 * visible and prevent misclassifying delegating / utility workflows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS_DIR = join(process.cwd(), "src/workflows");

function workflowDirs(): string[] {
  return readdirSync(WORKFLOWS_DIR).filter((name) => {
    const full = join(WORKFLOWS_DIR, name);
    return statSync(full).isDirectory();
  });
}

for (const dir of workflowDirs()) {
  const workflowFile = join(WORKFLOWS_DIR, dir, "workflow.ts");
  let src: string;
  try {
    src = readFileSync(workflowFile, "utf8");
  } catch {
    continue; // no workflow.ts — skip (e.g. index-only dirs)
  }

  if (!src.includes("defineWorkflow(")) continue;

  test(`${dir}/workflow.ts declares archetype in defineWorkflow`, () => {
    assert.ok(
      src.includes("archetype:"),
      `src/workflows/${dir}/workflow.ts calls defineWorkflow but does not declare 'archetype:'. ` +
        `Add 'archetype: "single"|"batch"|"delegating"|"delegating-batch"|"utility"' to the config object.`,
    );
  });
}
