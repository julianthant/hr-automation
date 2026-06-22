import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { log } from "../../utils/log.js";
import { workflowPresentationDir, workflowPresentationFile } from "../paths.js";
import { WorkflowOverrideSchema } from "./schema.js";
import type { WorkflowOverride } from "../../domain/workflow-presentation/types.js";

export function readOverride(repoRoot: string, workflow: string): WorkflowOverride | null {
  const file = workflowPresentationFile(repoRoot, workflow);
  if (!existsSync(file)) return null;
  try {
    const parsed = WorkflowOverrideSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) {
      const issuesSummary = parsed.error.issues.map((i) => i.message).join("; ");
      log.warn(`workflow-presentation override invalid for "${workflow}"; ignoring (${issuesSummary})`);
      return null; // fail-soft on READ so a bad file can't break the dashboard; writes are validated hard
    }
    return parsed.data as WorkflowOverride;
  } catch (err) {
    log.warn(`workflow-presentation override unreadable for "${workflow}"; ignoring (${String(err)})`);
    return null;
  }
}

export function writeOverride(repoRoot: string, workflow: string, override: WorkflowOverride): void {
  const validated = WorkflowOverrideSchema.parse(override); // throw on invalid WRITE (fail loud)
  mkdirSync(workflowPresentationDir(repoRoot), { recursive: true });
  writeFileSync(workflowPresentationFile(repoRoot, workflow), JSON.stringify(validated, null, 2) + "\n", "utf8");
}

export function deleteOverride(repoRoot: string, workflow: string): boolean {
  const file = workflowPresentationFile(repoRoot, workflow);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

export function listOverrides(repoRoot: string): string[] {
  const dir = workflowPresentationDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
}
