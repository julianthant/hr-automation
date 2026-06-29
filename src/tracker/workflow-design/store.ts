import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { log } from "../../utils/log.js";
import { workflowDesignDir, workflowDesignFile, workflowDesignBriefFile } from "../paths.js";
import { renderDesignBrief } from "../../domain/workflow-design/brief.js";
import type { WorkflowDesignSpec } from "../../domain/workflow-design/types.js";
import { WorkflowDesignSchema } from "./schema.js";

export function readDesign(repoRoot: string, workflow: string): WorkflowDesignSpec | null {
  const file = workflowDesignFile(repoRoot, workflow);
  if (!existsSync(file)) return null;
  try {
    const parsed = WorkflowDesignSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) {
      const issuesSummary = parsed.error.issues.map((i) => i.message).join("; ");
      log.warn(`workflow-design spec invalid for "${workflow}"; ignoring (${issuesSummary})`);
      return null; // fail-soft on READ; writes are validated hard
    }
    return parsed.data as WorkflowDesignSpec;
  } catch (err) {
    log.warn(`workflow-design spec unreadable for "${workflow}"; ignoring (${String(err)})`);
    return null;
  }
}

export interface WrittenDesign {
  jsonPath: string;
  mdPath: string;
}

/** Validate (fail loud), then write the JSON spec + the generated markdown brief. */
export function writeDesign(repoRoot: string, workflow: string, spec: WorkflowDesignSpec): WrittenDesign {
  const validated = WorkflowDesignSchema.parse(spec) as WorkflowDesignSpec; // throw on invalid WRITE
  mkdirSync(workflowDesignDir(repoRoot), { recursive: true });
  const jsonPath = workflowDesignFile(repoRoot, workflow);
  const mdPath = workflowDesignBriefFile(repoRoot, workflow);
  writeFileSync(jsonPath, JSON.stringify(validated, null, 2) + "\n", "utf8");
  writeFileSync(mdPath, renderDesignBrief(validated), "utf8");
  return { jsonPath, mdPath };
}

export function deleteDesign(repoRoot: string, workflow: string): boolean {
  let removed = false;
  for (const file of [workflowDesignFile(repoRoot, workflow), workflowDesignBriefFile(repoRoot, workflow)]) {
    if (existsSync(file)) {
      rmSync(file);
      removed = true;
    }
  }
  return removed;
}
